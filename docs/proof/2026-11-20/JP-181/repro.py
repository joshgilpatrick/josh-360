#!/usr/bin/env python3
"""JP-181 reproduction, on made-up data only: does `ledger-record` stay cut off at its timeout pass after pass?

It builds a throwaway JOSH360_HOME and ~/.claude with N quiet made-up sessions on JP-9xx branches, starts a local
stand-in for Jira that answers every read after DELAY seconds, then runs `python3 ledger/record.py` the way
laptop/run_jobs.py does (a subprocess with a timeout, exit 124 when it is cut off), PASSES times in a row. TIMEOUT
stands in for the job's real 10 minutes; DELAY stands in for a slow real Jira read.

    python3 docs/proof/2026-11-20/JP-181/repro.py [--timeout 15] [--delay 0.1] [--sessions 120] [--tickets 12]
                                                  [--passes 4] [--budget 9]

Nothing here touches the real ledger, transcripts or Jira. Python 3.9, standard library only.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
EPIC = "JP-94"


def transcript(sid: str, branch: str) -> str:
    lines = []
    for i, kind in enumerate(("user", "assistant", "user", "assistant")):
        at = "2026-11-19T09:0{}:00Z".format(i)
        line = {"type": kind, "timestamp": at, "sessionId": sid, "uuid": "u-{}-{}".format(sid, i),
                "isSidechain": False, "cwd": "/tmp/made-up/josh_360", "gitBranch": branch}
        line["message"] = {"role": kind, "content": "made-up text"}
        lines.append(json.dumps(line))
    return "\n".join(lines) + "\n"


def jira_stand_in(delay: float) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            self.server.reads += 1  # type: ignore[attr-defined]
            time.sleep(delay)
            key = self.path.split("/issue/")[1].split("?")[0]
            issue = {"key": key, "names": {}, "fields": {"labels": [], "issuelinks": [],
                                                          "issuetype": {"name": "Epic" if key == EPIC else "Task"}}}
            if key != EPIC:
                issue["fields"]["parent"] = {"key": EPIC}
            body = json.dumps(issue).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.reads = 0  # type: ignore[attr-defined]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--timeout", type=float, default=15.0)
    ap.add_argument("--delay", type=float, default=0.1)
    ap.add_argument("--sessions", type=int, default=120)
    ap.add_argument("--passes", type=int, default=4)
    ap.add_argument("--tickets", type=int, default=12, help="how many made-up tickets the sessions share")
    ap.add_argument("--budget", default=None, help="passed on to ledger/record.py as --budget (after the fix)")
    args = ap.parse_args()

    tmp = Path(tempfile.mkdtemp(prefix="jp181-"))
    try:
        home, j360 = tmp / "home", tmp / "home" / ".josh-360"
        projects = home / ".claude" / "projects" / "-made-up"
        projects.mkdir(parents=True)
        old = time.time() - 3600  # quiet for an hour, well inside the recorder's 14-day window
        for n in range(args.sessions):
            path = projects / "sess-{:04d}.jsonl".format(n)
            path.write_text(transcript(path.stem, "JP-{}-made-up".format(900 + n % args.tickets)), encoding="utf-8")
            os.utime(str(path), (old, old))
        server = jira_stand_in(args.delay)
        env = {k: v for k, v in os.environ.items() if k.lower() not in ("http_proxy", "https_proxy", "all_proxy")}
        env.update(HOME=str(home), JOSH360_HOME=str(j360), NO_PROXY="127.0.0.1", no_proxy="127.0.0.1",
                   JOSH360_JIRA_EMAIL="made-up@example.test", JOSH360_JIRA_TOKEN="made-up-token",
                   JOSH360_JIRA_SITE="http://127.0.0.1:{}".format(server.server_address[1]))
        subprocess.run([sys.executable, str(ROOT / "ledger" / "db.py")], env=env, check=True,
                       stdout=subprocess.DEVNULL)
        print("made-up sessions: {} on {} tickets, Jira stand-in delay {}s per read, job timeout {}s, budget {}".format(
            args.sessions, args.tickets, args.delay, args.timeout, args.budget or "(none)"))
        for n in range(1, args.passes + 1):
            reads_before, started = server.reads, time.time()  # type: ignore[attr-defined]
            try:
                command = [sys.executable, str(ROOT / "ledger" / "record.py")]
                command += ["--budget", args.budget] if args.budget else []
                done = subprocess.run(command, cwd=str(ROOT),
                                      env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                      universal_newlines=True, timeout=args.timeout)
                code, out = done.returncode, done.stdout.strip() or done.stderr.strip()[-300:]
            except subprocess.TimeoutExpired:
                code, out = 124, "(cut off at the timeout)"
            mark = j360 / "state" / "ledger-record.json"
            saved = json.loads(mark.read_text(encoding="utf-8")) if mark.is_file() else None
            conn = sqlite3.connect("file:{}?mode=ro".format(j360 / "state" / "ledger.db"), uri=True)
            episodes = conn.execute("SELECT COUNT(*) FROM session_episodes").fetchone()[0]
            failed = conn.execute("SELECT COUNT(*) FROM current_homes WHERE jira_read = 'failed'").fetchone()[0]
            conn.close()
            print("pass {}: exit {} after {:.1f}s | Jira reads {} | episodes {} | homes failed {} | mark saved: {} | "
                  "rehomed: {} | {}".format(
                      n, code, time.time() - started, server.reads - reads_before, episodes, failed,  # type: ignore
                      saved is not None, (saved or {}).get("rehomed"), out))
        server.shutdown()
    finally:
        shutil.rmtree(str(tmp), ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
