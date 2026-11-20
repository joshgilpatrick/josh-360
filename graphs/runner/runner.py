#!/usr/bin/env python3
"""The graph runner's command line (JP-117). Python 3.9, standard library only.

  tick                                  one pass: watch Jira, start runs, launch an advance for each run that can move
  advance --run <id>                    move one run forward as far as it can go now
  start --graph <g> --ticket <KEY> [--input name=value ...]    start a run by hand (starts no session)
  status [--json]                       what the runner is doing now
  report --run <id> [--json] [--from-json <file>]    the step table of a run (from the ledger, with each step's cost; or from a published snapshot, which has none)
  where <KEY> [--json] [--from-json <file>]    where a ticket is: every run on it, its step, Jira status, state, what it
                                        waits on, its sessions and their cost (or, from a published snapshot, the newest
                                        run and no cost) (JP-172)
  resume --run <id>                     carry on with a stopped run from the step it stopped at (JP-183); for a stop that
                                        started no model the step's run count is unchanged, so no allow is needed
  loop                                  the terminal host's loop (refuses under the job host)
  messages [--json]                     lead messages no lead was running to receive (JP-175), oldest first

Each command prints one JSON value (text for `status` and `report`) and exits 0, or exits 2 with {"error": ...}. Every
command takes --graphs-root, which tests use to point at another graphs folder.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from runner_lib import advance, leads, paths, status, tick, walk, where  # noqa: E402
from ledger import db  # noqa: E402


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="runner.py", description="The graph runner (JP-117).")
    sub = p.add_subparsers(dest="command", required=True)

    def command(name: str):
        s = sub.add_parser(name)
        s.add_argument("--graphs-root", type=Path)
        return s

    command("tick")
    s = command("advance")
    s.add_argument("--run", required=True)
    s = command("start")
    s.add_argument("--graph", required=True)
    s.add_argument("--ticket", required=True)
    s.add_argument("--input", action="append", default=[])
    s = command("status")
    s.add_argument("--json", action="store_true")
    s = command("report")
    s.add_argument("--run", required=True)
    s.add_argument("--json", action="store_true")
    s.add_argument("--from-json", type=Path)
    s = command("where")
    s.add_argument("key")
    s.add_argument("--json", action="store_true")
    s.add_argument("--from-json", type=Path)
    s = command("resume")
    s.add_argument("--run", required=True)
    command("loop")
    s = command("messages")
    s.add_argument("--json", action="store_true")
    return p


def _snapshot() -> dict:
    conn = db.connect(db.ledger_path())
    try:
        return status.snapshot(conn, time.time())
    finally:
        conn.close()


def _run(args) -> str:
    if args.command == "tick":
        return json.dumps(tick.tick(), sort_keys=True)
    if args.command == "advance":
        return json.dumps(advance.advance(args.run), sort_keys=True)
    if args.command == "start":
        argv = ["start", "--graph", args.graph, "--ticket", args.ticket, "--runner", "agent-manager"]
        for item in args.input:
            argv += ["--input", item]
        return json.dumps(walk.call(*argv), sort_keys=True)
    if args.command == "resume":
        return json.dumps(walk.call("retry", "--run", args.run), sort_keys=True)
    if args.command == "status":
        snap = _snapshot()
        return json.dumps(snap, sort_keys=True) if args.json else status.text(snap)
    if args.command == "report":
        if args.from_json:
            report = status.report_from_snapshot(json.loads(args.from_json.read_text(encoding="utf-8")), args.run)
        else:
            conn = db.connect(db.ledger_path())
            try:
                report = status.run_report(conn, args.run, with_cost=True)
            finally:
                conn.close()
        return json.dumps(report, sort_keys=True) if args.json else status.render(report)
    if args.command == "messages":
        rows = leads.unsent()
        if args.json:
            return json.dumps(rows, sort_keys=True)
        return "\n".join("{} {}: {} (kept: {})".format(r["run"], r["event"], r["text"], r["kept"]) for r in rows) \
            or "no unsent lead messages"
    if args.command == "where":
        if args.from_json:
            answer = where.from_snapshot(json.loads(args.from_json.read_text(encoding="utf-8")), args.key)
        else:
            conn = db.connect(db.ledger_path())
            try:
                answer = where.where(conn, args.key, time.time(), paths.graphs_root())
            finally:
                conn.close()
        return where.dumps(answer) if args.json else where.render(answer)
    tick.loop()
    return json.dumps({"loop": "ended"})


def main(argv=None, out=None) -> int:
    out = out or sys.stdout
    args = _parser().parse_args(argv)
    if args.graphs_root:
        os.environ["JOSH360_GRAPHS_ROOT"] = str(args.graphs_root)       # children (the detached advance) inherit it
    try:
        out.write(_run(args).rstrip("\n") + "\n")
        return 0
    except (walk.WalkerRefused, tick.LoopRefused, ValueError, FileNotFoundError, OSError) as err:
        out.write(json.dumps({"error": str(err)}) + "\n")
        return 2


if __name__ == "__main__":
    sys.exit(main())
