#!/usr/bin/env python3
"""Build the JSON copy of every graph file (JP-114, review finding B2). Needs PyYAML, so it runs in the cloud.

The walker runs on the laptop's Python 3.9 with the standard library only, which cannot read YAML. So each graph
that passes the checker is copied to graphs/compiled/<graph>.json together with the tier table, the facts about the
roles and agents it names, and the SHA-256 of every source file it came from. The walker refuses a copy whose
sources no longer match. A graph the checker refuses gets no copy.

    python3 graphs/tools/compile_graphs.py            # write the copies
    python3 graphs/tools/compile_graphs.py --check    # fail when a copy is missing, stale or has no graph file
    python3 graphs/tools/compile_graphs.py --root <parts folder> --out <folder>
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import check_graph  # noqa: E402

COMPILED = 1


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build(root: Path, graph_file: Path, parts: "check_graph.Parts") -> dict:
    """The JSON copy of one graph that has already passed the checker."""
    data = check_graph.load_yaml(graph_file)
    steps = data.get("steps") or []
    role_names = sorted({s["role"] for s in steps if "role" in s})
    agent_names = set()
    for s in steps:
        agent = s.get("agent")
        if isinstance(agent, str):
            agent_names.add(agent)
        elif isinstance(agent, dict):
            agent_names.update(v for v in (agent.get("map") or {}).values() if isinstance(v, str))
            if isinstance(agent.get("default"), str):
                agent_names.add(agent["default"])
    sources = {"flows/" + graph_file.name: sha256_file(graph_file), "tiers.yaml": sha256_file(root / "tiers.yaml")}
    roles = {}
    for name in role_names:
        sources["roles/{}/role.yaml".format(name)] = sha256_file(root / "roles" / name / "role.yaml")
        r = parts.roles[name]
        roles[name] = {"title": r["title"], "may_change": r["may_change"], "tier": r["tier"],
                       "reviewer": bool(r.get("reviewer", False))}
    agents = {}
    for name in sorted(agent_names):
        sources["agents/{}/agent.yaml".format(name)] = sha256_file(root / "agents" / name / "agent.yaml")
        agents[name] = {"title": parts.agents[name]["title"], "fills": parts.agents[name]["fills"]}
    tiers = check_graph.load_yaml(root / "tiers.yaml")
    return {"compiled": COMPILED, "graph": data, "tiers": tiers["tiers"], "max_runs": tiers["max_runs"],
            "roles": roles, "agents": agents, "sources": dict(sorted(sources.items()))}


def render(doc: dict) -> str:
    return json.dumps(doc, indent=1, sort_keys=True, ensure_ascii=False) + "\n"


def main(argv=None) -> int:
    default_root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description="Write graphs/compiled/<graph>.json for every graph.")
    parser.add_argument("--root", type=Path, default=default_root, help="the parts folder (tiers.yaml, flows/, ...)")
    parser.add_argument("--out", type=Path, default=None, help="where the copies go (default <root>/compiled)")
    parser.add_argument("--check", action="store_true", help="write nothing; fail when a copy is missing or stale")
    args = parser.parse_args(argv)
    if check_graph.yaml is None:
        print("compile_graphs: cannot run: PyYAML is not installed (pip install -r requirements.txt)")
        return 2
    out = args.out or args.root / "compiled"
    parts = check_graph.load_parts(args.root)
    problems = ["{}: {}".format(args.root.name, p) for p in parts.problems]
    wanted = {}
    for path in sorted((args.root / "flows").glob("*.yaml")):
        try:
            found = check_graph.check_graph_data(check_graph.load_yaml(path), path.stem, parts)
        except check_graph.GraphYamlError as exc:
            found = [str(exc)]
        if found or parts.problems:
            problems += ["{}: {}".format(path.name, p) for p in found]
            continue
        wanted[path.stem + ".json"] = render(build(args.root, path, parts))
    for name, text in wanted.items():
        target = out / name
        if args.check:
            if not target.is_file():
                problems.append("{}: missing (run python3 graphs/tools/compile_graphs.py)".format(name))
            elif target.read_text(encoding="utf-8") != text:
                problems.append("{}: stale (run python3 graphs/tools/compile_graphs.py)".format(name))
        else:
            out.mkdir(parents=True, exist_ok=True)
            target.write_text(text, encoding="utf-8")
    if out.is_dir():
        for extra in sorted(out.glob("*.json")):
            if extra.name not in wanted and (args.root / "flows" / (extra.stem + ".yaml")).is_file() is False:
                if args.check:
                    problems.append("{}: no graph file for it".format(extra.name))
                else:
                    extra.unlink()
    for p in problems:
        print(p)
    print("compile_graphs: {}".format("FAILED ({} problem(s))".format(len(problems)) if problems
                                      else "ok ({} graph(s))".format(len(wanted))))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
