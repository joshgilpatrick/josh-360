"""The walker's commands. Each prints one line of JSON and exits 0, or prints {"error": ...} and exits 2."""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from pathlib import Path
from typing import Dict, List, Optional

from ledger import db

from . import engine, gates, graphfile, ledgerio, questions, runfolder, runner
from .graphfile import Refused

KEY = re.compile(r"^[A-Z][A-Z0-9]*-[0-9]+$")
SUBJECT_KINDS = ("intake", "pr")


def _coerce(name: str, spec: dict, raw: str):
    kind = spec.get("type", "string")
    try:
        if kind == "number":
            return float(raw) if "." in raw else int(raw)
        if kind == "boolean":
            if raw.lower() not in ("true", "false"):
                raise ValueError
            return raw.lower() == "true"
        if kind == "list":
            value = json.loads(raw)
            if not isinstance(value, list):
                raise ValueError
            return value
    except ValueError:
        raise Refused("input '{}' must be a {}".format(name, kind))
    return raw


def read_inputs(graph, pairs: List[str], ticket: Optional[str]) -> Dict[str, object]:
    given = {}
    for pair in pairs:
        if "=" not in pair:
            raise Refused("--input wants name=value, not '{}'".format(pair))
        name, raw = pair.split("=", 1)
        if name not in graph.inputs:
            raise Refused("the graph '{}' has no input '{}'".format(graph.id, name))
        given[name] = _coerce(name, graph.inputs[name], raw)
    if ticket and "ticket_key" in graph.inputs and "ticket_key" not in given:
        given["ticket_key"] = ticket
    values = {}
    for name, spec in graph.inputs.items():
        if name in given:
            values[name] = given[name]
        elif "default" in spec:
            values[name] = spec["default"]
        elif spec.get("required"):
            raise Refused("the input '{}' is required".format(name))
    return values


def _load_run(conn, graph_root: Path, run_id: str, live_check: bool = True) -> runner.Run:
    row = ledgerio.run_row(conn, run_id)
    if row is None:
        raise Refused("there is no run {}".format(run_id))
    graph = graphfile.load(row["graph_id"], graph_root, live_check)
    try:
        doc = runfolder.load(run_id)
    except FileNotFoundError as exc:
        raise Refused(str(exc))
    return runner.Run(conn, graph, run_id, row, doc)


def cmd_start(conn, root: Path, args) -> dict:
    graph = graphfile.load(args.graph, root)
    ticket = args.ticket
    if ticket:
        if not KEY.match(ticket):
            raise Refused("'{}' is not a ticket key".format(ticket))
        kind, ref = "ticket", ticket
    else:
        if args.subject_kind not in SUBJECT_KINDS or not args.subject_ref:
            raise Refused("give --ticket KEY, or --subject-kind intake|pr with --subject-ref")
        kind, ref = args.subject_kind, args.subject_ref
    values = read_inputs(graph, args.input or [], ticket)
    now = ledgerio.now()
    if ticket and not args.allow_repeat and ledgerio.runs_in_last_day(conn, ticket, now) >= ledgerio.RUNS_PER_DAY:
        raise Refused("{} has already had {} runs in the last 24 hours. Something may be looping; look at it, then "
                      "use --allow-repeat to go on".format(ticket, ledgerio.RUNS_PER_DAY))
    run_id = runfolder.new_run_id()
    doc = {"graph": graph.id, "ticket": ticket, "inputs": values, "outputs": {}, "allow": [], "stopped": None,
           "jira_status": None, "flag_on": False}
    runfolder.create(run_id, doc)
    env = gates.gate_env(values, list(graph.inputs), run_id, str(runfolder.runs_dir()), ticket, None)
    result = gates.run_gate(graph.root, graph.header["entry_gate"], env, runfolder.folder(run_id), None)
    if result.error or result.outcome != "pass":
        shutil.rmtree(str(runfolder.folder(run_id)), ignore_errors=True)
        raise Refused("the entry gate '{}' did not admit the run: {}".format(
            graph.header["entry_gate"], result.error or "it printed '{}'".format(result.outcome)))
    with db.transaction(conn):
        ledgerio.create_run(conn, run_id=run_id, graph_id=graph.id, graph_version=graphfile.graph_version(graph),
                            repo_commit=graphfile.repo_commit(graph), subject_kind=kind, subject_ref=ref,
                            ticket_key=ticket, phi=args.phi, runner=args.runner, now=now)
        row_id = ledgerio.start_step(conn, run_id, engine.ENTRY, "gate", 1, 0, None, None, None, False, now)
        ledgerio.end_step(conn, row_id, "pass", ledgerio.now(), None, None, runner_note(result.summary, args.phi))
    return {"started": True, "run": run_id, "graph": graph.id, "graph_version": graphfile.graph_version(graph)}


def runner_note(text: Optional[str], phi: bool) -> Optional[str]:
    return None if phi or not text else text.strip().splitlines()[0][:200]


def cmd_next(conn, root: Path, args) -> dict:
    return runner.advance(_load_run(conn, root, args.run))


def cmd_record(conn, root: Path, args) -> dict:
    run = _load_run(conn, root, args.run)
    g = run.graph
    open_step = run.state.open_step
    if open_step != args.step or run.rows[-1]["kind"] != "role":
        raise Refused("step '{}' is not the role step this run is waiting on".format(args.step))
    if args.result_file:
        result = runfolder.read_result(Path(args.result_file))
        outcome, outputs = result["outcome"], result["outputs"]
        if args.outcome and args.outcome != outcome:
            raise Refused("--outcome and the result file disagree")
    elif args.outcome:
        outcome, outputs = args.outcome, {}
    else:
        raise Refused("give --outcome or --result-file")
    if outcome not in g.outcomes(args.step):
        raise Refused("'{}' is not an outcome of step '{}' ({})".format(outcome, args.step,
                                                                       ", ".join(g.outcomes(args.step))))
    declared = g.steps[args.step].get("outputs") or {}
    unknown = [k for k in outputs if k not in declared]
    if unknown:
        raise Refused("step '{}' does not declare the output '{}'".format(args.step, unknown[0]))
    session_uid = None
    if args.session:
        session_uid = ledgerio.ensure_session(conn, args.tool, args.session, ledgerio.now())
    runfolder.save_outputs(run.doc, args.step, outputs)
    run.save()
    if isinstance(outputs.get("answer"), str) and outputs["answer"].strip():
        runfolder.append_answer(args.run, args.step, outputs["answer"], ledgerio.now())
    ledgerio.end_step(conn, run.rows[-1]["id"], outcome, ledgerio.now(), args.model, session_uid, None)
    return {"recorded": True, "run": args.run, "step": args.step, "outcome": outcome}


def cmd_answer(conn, root: Path, args) -> dict:
    run = _load_run(conn, root, args.run)
    if run.state.open_step != args.step or run.rows[-1]["kind"] != "ask":
        raise Refused("step '{}' is not a question this run is waiting on".format(args.step))
    text = args.choice if args.choice is not None else args.text
    if not text or not text.strip():
        raise Refused("give --choice or --text")
    qid = questions.question_id(args.run, args.step, run.rows[-1]["attempt"])
    if not questions.answer(qid, text, ledgerio.now()):
        raise Refused("that question is not open")
    return {"answered": True, "run": args.run, "step": args.step}


def cmd_abandon(conn, root: Path, args) -> dict:
    run = _load_run(conn, root, args.run)
    step = run.state.open_step
    if not step or run.rows[-1]["kind"] != "role":
        raise Refused("this run has no role step waiting for a result")
    ledgerio.end_step(conn, run.rows[-1]["id"], engine.ABANDONED, ledgerio.now(), None, None, None)
    return {"abandoned": True, "run": args.run, "step": step}


def cmd_allow(conn, root: Path, args) -> dict:
    run = _load_run(conn, root, args.run)
    if args.step not in run.graph.steps or run.graph.kind(args.step) != "role":
        raise Refused("'{}' is not a role step of this graph".format(args.step))
    run.doc.setdefault("allow", []).append(args.step)
    run.doc["stopped"] = None
    run.save()
    return {"allowed": True, "run": args.run, "step": args.step}


def cmd_retry(conn, root: Path, args) -> dict:
    run = _load_run(conn, root, args.run)
    if not run.doc.get("stopped"):
        raise Refused("this run is not stopped")
    run.doc["stopped"] = None
    run.save()
    return {"retrying": True, "run": args.run}


def cmd_status(conn, root: Path, args) -> dict:
    run = _load_run(conn, root, args.run)
    st = run.state
    return {
        "run": args.run, "graph": run.graph.id, "ticket": run.ticket, "ended": run.state.ended,
        "end": ledgerio.run_end(conn, args.run), "stopped": run.doc.get("stopped"),
        "steps": [{k: r[k] for k in ("step", "attempt", "outcome", "allowed")} for r in run.rows],
        "runs": dict(st.runs), "loops": {"{}->{}".format(a, b): n for (a, b), n in sorted(st.loops.items())},
        "waiting": run.doc.get("waiting"),
        "jira_status": run.doc.get("jira_status"), "flag_on": bool(run.doc.get("flag_on"))}


COMMANDS = {"start": cmd_start, "next": cmd_next, "record": cmd_record, "answer": cmd_answer, "abandon": cmd_abandon,
            "allow": cmd_allow, "retry": cmd_retry, "status": cmd_status}


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="walker.py", description="Says the next step of a graph run (JP-114).")
    p.add_argument("--root", type=Path, default=graphfile.GRAPHS, help="the graphs folder (tests use another)")
    sub = p.add_subparsers(dest="command", required=True)
    s = sub.add_parser("start")
    s.add_argument("--graph", required=True)
    s.add_argument("--ticket")
    s.add_argument("--subject-kind")
    s.add_argument("--subject-ref")
    s.add_argument("--input", action="append")
    s.add_argument("--runner", default="cli", choices=("agent-manager", "daemon", "cli", "other"))
    s.add_argument("--phi", action="store_true", help="store no text from this run in the ledger")
    s.add_argument("--allow-repeat", action="store_true")
    for name in ("next", "abandon", "retry", "status"):
        sub.add_parser(name).add_argument("--run", required=True)
    s = sub.add_parser("record")
    s.add_argument("--run", required=True)
    s.add_argument("--step", required=True)
    s.add_argument("--outcome")
    s.add_argument("--result-file")
    s.add_argument("--session")
    s.add_argument("--model")
    s.add_argument("--tool", default="claude-code", choices=("claude-code", "opencode", "pi", "codex", "other"))
    s = sub.add_parser("answer")
    s.add_argument("--run", required=True)
    s.add_argument("--step", required=True)
    group = s.add_mutually_exclusive_group(required=True)
    group.add_argument("--choice")
    group.add_argument("--text")
    s = sub.add_parser("allow")
    s.add_argument("--run", required=True)
    s.add_argument("--step", required=True)
    return p


def main(argv: Optional[List[str]] = None, out=None) -> int:
    out = out or sys.stdout
    args = parser().parse_args(argv)
    try:
        conn = ledgerio.connect()
    except FileNotFoundError as exc:
        out.write(json.dumps({"error": str(exc)}) + "\n")
        return 2
    try:
        result = COMMANDS[args.command](conn, args.root, args)
    except (Refused, engine.Corrupt, ValueError) as exc:
        out.write(json.dumps({"error": str(exc)}) + "\n")
        return 2
    finally:
        conn.close()
    out.write(json.dumps(result, sort_keys=True) + "\n")
    return 0
