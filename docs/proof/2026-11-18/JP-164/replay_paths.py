#!/usr/bin/env python3
"""JP-164 proof: replay each designed path of the draft validation graph through the walker's own engine.

    python3 docs/proof/2026-11-18/JP-164/replay_paths.py        (from the repository root; needs PyYAML)

For each path it feeds the engine the outcome every step would give and prints the steps that ran and the end
the run reached. A step shown with "!" was reached because a loop hit its limit. Nothing is read or written
outside this process: no ledger, no Jira, no run folder.
"""
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[4]
DRAFT = ROOT / "docs/superpowers/specs/2026-11-18-post-deploy-validation-draft"
sys.path.insert(0, str(ROOT / "graphs/tools"))
from walker_lib import engine  # noqa: E402
from walker_lib.graphfile import Graph  # noqa: E402


def load() -> Graph:
    data = yaml.safe_load((DRAFT / "flows/validation.yaml").read_text(encoding="utf-8"))
    for step in data["steps"]:
        if True in step:            # plain YAML reads the key "on" as true; the checker and compiler read it as a word
            step["on"] = step.pop(True)
    tiers = yaml.safe_load((DRAFT / "tiers.yaml").read_text(encoding="utf-8"))
    return Graph({"graph": data, "tiers": tiers["tiers"], "max_runs": tiers["max_runs"], "roles": {}, "agents": {}}, DRAFT)


def replay(graph: Graph, name: str, outcomes: dict) -> str:
    state, trail = engine.State(), []
    queue = {step: list(values) for step, values in outcomes.items()}
    while True:
        action = engine.decide(graph, state)
        if action.kind == "done":
            break
        if action.kind == "exit":
            engine.begin(graph, state, engine.EXIT)
            engine.finish(graph, state, engine.EXIT, "pass")
            break
        outcome = queue[action.step].pop(0)
        engine.begin(graph, state, action.step, allowed=action.allowed)
        engine.finish(graph, state, action.step, outcome)
        trail.append("{}{}={}".format("!" if action.forced else "", action.step, outcome))
    print("{}\n    ends: {}\n    {}".format(name, state.ended, " > ".join(trail)))
    return state.ended


PATHS = [
    ("Criteria met", "finished",
     {"read_criteria": ["watch"], "start_watch": ["started"], "watch": ["met"], "verdict": ["met"], "close": ["closed"]}),
    ("Nothing to watch", "close_unwatched.closed",
     {"read_criteria": ["not_needed"], "verdict": ["not_needed"], "close_unwatched": ["closed"]}),
    ("Josh moves the ticket during the watch", "watch.left_deployed",
     {"read_criteria": ["watch"], "start_watch": ["started"], "watch": ["left_deployed"]}),
    ("Section unreadable, Josh fixes it, watch again, met", "finished",
     {"read_criteria": ["unreadable", "watch"], "verdict": ["undecided", "met"], "decide": ["watch_again"],
      "start_watch": ["started"], "watch": ["met"], "close": ["closed"]}),
    ("No data, Josh accepts", "close_accepted.closed",
     {"read_criteria": ["watch"], "start_watch": ["started"], "watch": ["no_data"], "verdict": ["undecided"],
      "decide": ["accept"], "close_accepted": ["closed"]}),
    ("No data, Josh stops", "hold.held",
     {"read_criteria": ["watch"], "start_watch": ["started"], "watch": ["no_data"], "verdict": ["undecided"],
      "decide": ["stop"], "hold": ["held"]}),
    ("A manual criterion, Josh confirms", "close_accepted.closed",
     {"read_criteria": ["watch"], "start_watch": ["started"], "watch": ["needs_josh"], "verdict": ["undecided"],
      "decide": ["accept"], "close_accepted": ["closed"]}),
    ("Not met, fix ships, met", "finished",
     {"read_criteria": ["watch"] * 2, "start_watch": ["started"] * 2, "watch": ["not_met", "met"],
      "verdict": ["not_met", "met"], "file_bug": ["filed"], "await_fix": ["shipped"], "close": ["closed"]}),
    ("Not met, fix cancelled, Josh accepts", "close_accepted.closed",
     {"read_criteria": ["watch"], "start_watch": ["started"], "watch": ["not_met"], "verdict": ["not_met"],
      "file_bug": ["filed"], "await_fix": ["cancelled"], "decide": ["accept"], "close_accepted": ["closed"]}),
    ("Not met, Josh moves the ticket while the fix is open", "await_fix.left_deployed",
     {"read_criteria": ["watch"], "start_watch": ["started"], "watch": ["not_met"], "verdict": ["not_met"],
      "file_bug": ["filed"], "await_fix": ["left_deployed"]}),
    ("Not met twice, second fix ships, Josh allows a third watch, met", "finished",
     {"read_criteria": ["watch"] * 3, "start_watch": ["started"] * 3, "watch": ["not_met", "not_met", "met"],
      "verdict": ["not_met", "not_met", "met"], "file_bug": ["filed"] * 2, "await_fix": ["shipped"] * 2,
      "decide": ["watch_again"], "close": ["closed"]}),
    ("Not met twice, second fix ships, Josh stops", "hold.held",
     {"read_criteria": ["watch"] * 2, "start_watch": ["started"] * 2, "watch": ["not_met"] * 2,
      "verdict": ["not_met"] * 2, "file_bug": ["filed"] * 2, "await_fix": ["shipped"] * 2, "decide": ["stop"],
      "hold": ["held"]}),
]

if __name__ == "__main__":
    graph = load()
    wrong = [name for name, want, outcomes in PATHS if replay(graph, name, outcomes) != want]
    print("\n{} paths, {} ended somewhere other than designed".format(len(PATHS), len(wrong)))
    sys.exit(1 if wrong else 0)
