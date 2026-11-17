#!/usr/bin/env python3
"""Walk the development graph draft on made-up outcomes, with the walker's own engine (JP-115 design proof).

No session, gate script, ledger or Jira is touched: each scenario names the outcome every step ends with, and
the walker's pure functions (graphs/tools/walker_lib/engine.py) decide what comes next, including loop limits
and the run cap. A wait step is walked as the gate it calls (its `pending` answers are not modelled). The JP-115
build replaces this with the real dry run through walker.py; delete this file then.
"""
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(ROOT / "graphs/tools")]
import check_graph  # noqa: E402
import compile_graphs  # noqa: E402
from walker_lib import engine  # noqa: E402
from walker_lib.graphfile import Graph  # noqa: E402

DRAFT = Path(__file__).resolve().parent / "development.yaml"

HAPPY = {"read_ticket": "build", "prepare": "ready", "design": "ready", "lint": "complete", "harden": "pass",
         "build": "done", "verify": "passed", "review_plan": "complete", "write_pr": "written", "open_pr": "opened",
         "queue_audit": "queued", "await_review": "ready", "merge_rule": "agent", "merge": "merged",
         "clean_up": "cleaned", "close": "closed"}

SCENARIOS = {
    "1. Story in josh-360: one hardening round, one audit round with 2 findings, merged by the graph": dict(HAPPY, **{
        "harden": ["defects", "pass"], "check_harden": "rework", "lint": "complete", "design": "ready",
        "await_review": ["changes", "ready"], "fix_review": "fixed", "after_fix": "relabel"}),
    "2. Bug in another repository: a builder question the spec answers, a plan-review defect, Josh merges": dict(HAPPY, **{
        "build": ["needs_judgment", "done", "done"], "triage_question": "answered",
        "review_plan": ["defects", "complete"], "cite_check": "rework", "merge_rule": "josh", "await_merge": "merged"}),
    "3. Research ticket: design and plan, Josh approves, Josh merges": dict(HAPPY, **{
        "read_ticket": "design_only", "approve_design": "approve", "merge_rule": "josh", "await_merge": "merged"}),
    "4. Story whose designer has a question: back to triage": dict(HAPPY, **{
        "design": "needs_input", "route_question": "to_triage", "return_question": "returned"}),
    "5. Builder keeps failing its checks: the run cap sends it to Josh, who stops": dict(HAPPY, **{
        "verify": "failed", "build_stuck": "stop"}),
    "6. Audit asks for 5 changes, a re-audit, then Josh's merge is closed unmerged": dict(HAPPY, **{
        "await_review": ["changes", "ready"], "fix_review": "fixed", "after_fix": "requeue", "merge_rule": "josh",
        "await_merge": "closed"}),
}


def load() -> Graph:
    text = "\n".join(l.replace("wait:", "gate:", 1) if l.strip().startswith("wait:") else l
                     for l in DRAFT.read_text(encoding="utf-8").splitlines()) + "\n"
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "development.yaml"
        path.write_text(text, encoding="utf-8")
        root = ROOT / "graphs"
        doc = compile_graphs.build(root, path, check_graph.load_parts(root))
    return Graph(doc, ROOT / "graphs")


def walk(g: Graph, plan: dict) -> tuple:
    st, seen, statuses, trail = engine.State(), {}, [], []
    st.entered = True
    for _ in range(200):
        act = engine.decide(g, st)
        if act.kind == "done":
            return st.ended, statuses, trail
        if act.kind == "stopped":
            return "stopped: " + act.reason, statuses, trail
        if act.kind == "exit":
            engine.begin(g, st, engine.EXIT)
            engine.finish(g, st, engine.EXIT, "pass")
            trail.append("no-loose-ends")
            continue
        step = act.step
        status = g.stretch_status(step)
        if not statuses or statuses[-1] != status:
            statuses.append(status)
        want = plan.get(step)
        n = seen.get(step, 0)
        seen[step] = n + 1
        outcome = (want[min(n, len(want) - 1)] if isinstance(want, list) else want) or g.outcomes(step)[0]
        engine.begin(g, st, step)
        engine.finish(g, st, step, outcome)
        trail.append(f"{step}={outcome}")
    return "did not end in 200 steps", statuses, trail


def main() -> int:
    g = load()
    ok = True
    for name, plan in SCENARIOS.items():
        end, statuses, trail = walk(g, plan)
        score = g.end_score(end) if end in g.header["end_states"] or end in ("finished", "exit_refused") else "?"
        ok &= score != "?"
        print(name)
        print("   Jira:  " + " -> ".join(statuses))
        print("   steps: " + ", ".join(trail))
        print(f"   end:   {end} ({score})\n")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
