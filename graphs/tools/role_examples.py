#!/usr/bin/env python3
"""Every role step shows an example result that matches the step (JP-189). No model is called.

A role's `instructions.md` carries one or more example results for each step that uses the role, each a fenced JSON
block tagged with the step it is for:

    ```json result step=revise
    {"outcome": "revised", "outputs": {"proposal": "<work folder>/revise-1-proposal.json"}}
    ```

`check` reads every graph in `graphs/compiled/` and fails when a role step has no example, when an example's
`outcome` is not one the step declares, when it puts a key under `outputs` that the step does not declare (the walker
refuses that result, JP-184), or when a declared output appears in none of the step's examples. It also fails on a
tagged example for a step the role does not serve, and on an untagged ```json block holding an `outcome`, which
nothing would read. The stand-in Claude Code (`tests/e2e/standin/claude`) writes the step's first example by default.

    python3 graphs/tools/role_examples.py check [--root <graphs folder>]

Python 3.9, standard library only.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Dict, List, NamedTuple, Optional, Tuple

GRAPHS = Path(__file__).resolve().parent.parent
FENCE = re.compile(r"^```(json[^\n]*)\n(.*?)^```\s*$", re.M | re.S)
TAG = re.compile(r"^json\s+result\s+step=([a-z0-9_]+)\s*$")


class Example(NamedTuple):
    step: Optional[str]          # the tagged step, or None for an untagged block that holds an outcome
    line: int
    doc: Optional[dict]          # None when the block is not a JSON object
    error: Optional[str]


def examples_in(text: str) -> List[Example]:
    """Every tagged example in a role's instructions, plus every untagged ```json block that holds an `outcome`."""
    found: List[Example] = []
    for match in FENCE.finditer(text):
        info, body = match.group(1).strip(), match.group(2)
        line = text.count("\n", 0, match.start()) + 1
        tag = TAG.match(info)
        try:
            doc = json.loads(body)
            error = None if isinstance(doc, dict) else "is not a JSON object"
        except ValueError as exc:
            doc, error = None, "is not valid JSON ({})".format(exc)
        if not isinstance(doc, dict):
            doc = None
        if tag:
            found.append(Example(tag.group(1), line, doc, error))
        elif info.split()[0] == "json" and doc is not None and "outcome" in doc:
            found.append(Example(None, line, doc, None))
    return found


def example_for(text: str, step: str) -> Optional[dict]:
    """The first well-formed example for the step: what the stand-in writes by default."""
    for ex in examples_in(text):
        if ex.step == step and ex.doc is not None:
            return ex.doc
    return None


def role_steps(graphs: Path) -> Dict[str, List[Tuple[str, dict]]]:
    """role name -> [(graph, step)] over every compiled graph."""
    found: Dict[str, List[Tuple[str, dict]]] = {}
    for path in sorted((graphs / "compiled").glob("*.json")):
        compiled = json.loads(path.read_text(encoding="utf-8"))
        graph = compiled.get("graph") or {}
        for step in graph.get("steps") or []:
            if isinstance(step, dict) and step.get("role"):
                found.setdefault(step["role"], []).append((graph.get("graph") or path.stem, step))
    return found


def step_problems(graph: str, step: dict, examples: List[Example], where: str) -> List[str]:
    sid = step["id"]
    name = "step '{}' ({} graph, role {})".format(sid, graph, step["role"])
    mine = [ex for ex in examples if ex.step == sid]
    if not mine:
        return ["{}: no example result in {} (add a ```json result step={} block)".format(name, where, sid)]
    outcomes = list(step.get("outcomes") or [])
    declared = list((step.get("outputs") or {}).keys())
    problems: List[str] = []
    seen: set = set()
    for ex in mine:
        at = "{}:{}".format(where, ex.line)
        if ex.doc is None:
            problems.append("{}: the example at {} {}".format(name, at, ex.error))
            continue
        outcome, outputs = ex.doc.get("outcome"), ex.doc.get("outputs")
        if outcome not in outcomes:
            problems.append("{}: the example at {} has outcome {!r}, which is not one of the step's outcomes ({})"
                            .format(name, at, outcome, ", ".join(outcomes)))
        if not isinstance(outputs, dict):
            problems.append("{}: the example at {} has no \"outputs\" object".format(name, at))
            continue
        for key in outputs:
            if key not in declared:
                problems.append("{}: the example at {} puts {!r} under outputs, which the step does not declare "
                                "(it declares {})".format(name, at, key, ", ".join(declared) or "none"))
        others = [k for k in ex.doc if k not in ("outcome", "outputs", "follow_ups")]
        if others:
            problems.append("{}: the example at {} has {} beside outcome and outputs; the walker reads only those"
                            .format(name, at, ", ".join(repr(k) for k in others)))
        seen.update(outputs)
    for key in declared:
        if key not in seen:
            problems.append("{}: the declared output {!r} is in none of its examples".format(name, key))
    return problems


def problems(graphs: Path = GRAPHS) -> List[str]:
    found: List[str] = []
    for role, steps in sorted(role_steps(graphs).items()):
        path = graphs / "roles" / role / "instructions.md"
        where = str(path.relative_to(graphs.parent)) if path.is_relative_to(graphs.parent) else str(path)
        try:
            examples = examples_in(path.read_text(encoding="utf-8"))
        except OSError:
            found.append("role {}: no instructions file at {}".format(role, where))
            continue
        for graph, step in steps:
            found += step_problems(graph, step, examples, where)
        served = {step["id"] for _, step in steps}
        for ex in examples:
            if ex.step is None:
                found.append("role {}: the ```json block at {}:{} holds an outcome but names no step; tag it "
                             "```json result step=<step>".format(role, where, ex.line))
            elif ex.step not in served:
                found.append("role {}: the example at {}:{} is for step '{}', which no graph gives this role "
                             "(it serves {})".format(role, where, ex.line, ex.step, ", ".join(sorted(served))))
    return found


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    check = sub.add_parser("check", help="fail when a role step's example result does not match the step")
    check.add_argument("--root", type=Path, default=GRAPHS, help="the graphs folder (compiled/ and roles/)")
    args = parser.parse_args(argv)
    found = problems(args.root.resolve())
    for line in found:
        print(line)
    if not found:
        count = sum(len(s) for s in role_steps(args.root.resolve()).values())
        print("role examples: every one of {} role steps has a matching example".format(count))
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main())
