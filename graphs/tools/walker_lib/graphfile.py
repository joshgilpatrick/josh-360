"""Read one graph's JSON copy (graphs/compiled/<graph>.json) and answer questions about it. Standard library only.

The copy is written by graphs/tools/compile_graphs.py after the checker passes. `load` refuses a copy whose source
files no longer match the hashes recorded in it, and, where PyYAML is present, a graph the checker rejects.
"""
from __future__ import annotations

import hashlib
import json
import re
import subprocess
from pathlib import Path
from typing import Dict, List, Optional, Set

GRAPHS = Path(__file__).resolve().parent.parent.parent
TEMPLATE = re.compile(r"\{\{\s*inputs\.([A-Za-z0-9_]+)\s*\}\}")
SHORT_CODE = re.compile(r"^[a-z0-9._-]+$")


class Refused(Exception):
    """The walker will not do what was asked. The message says why, in plain words."""


class Graph:
    def __init__(self, doc: dict, root: Path):
        self.root = root
        self.doc = doc
        data = doc["graph"]
        self.id = data["graph"]
        self.data = data
        self.header = data["header"]
        self.order: List[str] = [s["id"] for s in data["steps"]]
        self.steps: Dict[str, dict] = {s["id"]: s for s in data["steps"]}
        self.tiers = doc["tiers"]
        self.max_runs = doc["max_runs"]
        self.roles = doc["roles"]
        self.agents = doc["agents"]
        self.inputs: Dict[str, dict] = data.get("inputs") or {}
        self._descendants: Dict[str, Set[str]] = {}

    def kind(self, step: str) -> str:
        s = self.steps[step]
        return "role" if "role" in s else "gate" if "gate" in s else "wait" if "wait" in s else "ask"

    def needs(self, step: str) -> List[str]:
        return list(self.steps[step].get("needs") or [])

    def outcomes(self, step: str) -> List[str]:
        s = self.steps[step]
        return list(s["ask"]["choices"]) if "ask" in s else list(s.get("outcomes") or [])

    def on(self, step: str, outcome: str):
        return (self.steps[step].get("on") or {}).get(outcome)

    def on_limit_only(self, step: str) -> bool:
        s = self.steps[step]
        return "ask" in s and bool(s["ask"].get("on_limit_only"))

    def tier(self, step: str) -> Optional[str]:
        s = self.steps[step]
        if "role" not in s:
            return None
        return s.get("tier") or self.roles[s["role"]]["tier"]

    def cap(self, step: str) -> Optional[int]:
        tier = self.tier(step)
        return None if tier is None else int(self.max_runs[tier])

    def descendants(self, step: str) -> Set[str]:
        """Every step that needs this one, directly or further down."""
        if not self._descendants:
            for sid in self.order:
                self._descendants[sid] = set()
            changed = True
            while changed:
                changed = False
                for sid in self.order:
                    for n in self.needs(sid):
                        add = {sid} | self._descendants[sid]
                        if not add <= self._descendants[n]:
                            self._descendants[n] |= add
                            changed = True
        return self._descendants[step]

    def stretch_status(self, step: str) -> Optional[str]:
        for stretch in self.header["jira"]:
            if step in stretch["steps"]:
                return stretch["status"]
        return None

    def resolve_agent(self, step: str, values: Dict[str, object]) -> Optional[str]:
        rule = self.steps[step].get("agent")
        if rule is None or isinstance(rule, str):
            return rule
        picked = rule.get("map", {}).get(str(values.get(rule["by"])))
        return picked or rule.get("default")

    def render(self, text: str, values: Dict[str, object]) -> str:
        return TEMPLATE.sub(lambda m: str(values.get(m.group(1), "")), text)

    def end_score(self, end_name: str) -> str:
        if end_name == "exit_refused":
            return "needs-josh"
        return self.header["end_states"][end_name]


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load(graph_id: str, root: Path = GRAPHS, live_check: bool = True) -> Graph:
    path = root / "compiled" / (graph_id + ".json")
    if not path.is_file():
        raise Refused("there is no checked copy of graph '{}'. Run python3 graphs/tools/compile_graphs.py; it "
                      "refuses a graph the checker rejects".format(graph_id))
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
        graph = Graph(doc, root)
    except (ValueError, KeyError, TypeError):
        raise Refused("the checked copy of graph '{}' is damaged; rebuild it with compile_graphs.py".format(graph_id))
    for rel, expected in doc.get("sources", {}).items():
        source = root / rel
        if not source.is_file() or sha256_file(source) != expected:
            raise Refused("the checked copy of graph '{}' is out of date ({} changed); run "
                          "python3 graphs/tools/compile_graphs.py".format(graph_id, rel))
    if live_check:
        _live_check(graph_id, root)
    return graph


def _live_check(graph_id: str, root: Path) -> None:
    """Where PyYAML is installed, run the checker on the graph file itself: a rejected graph is refused twice."""
    try:
        import yaml  # noqa: F401
    except ImportError:
        return
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    import check_graph  # noqa: E402
    parts = check_graph.load_parts(root)
    problems = list(parts.problems)
    try:
        problems += check_graph.check_graph_data(check_graph.load_yaml(root / "flows" / (graph_id + ".yaml")),
                                                 graph_id, parts)
    except (check_graph.GraphYamlError, OSError) as exc:
        problems.append(str(exc))
    if problems:
        raise Refused("the checker rejects graph '{}': {}".format(graph_id, problems[0]))


def graph_version(graph: Graph) -> str:
    """The last commit that changed the graph file; with no git, a short hash of the file."""
    rel = "flows/{}.yaml".format(graph.id)
    try:
        out = subprocess.run(["git", "log", "-1", "--format=%H", "--", rel], cwd=str(graph.root),
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, universal_newlines=True, timeout=20)
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        pass
    return "sha256:" + graph.doc["sources"][rel][:12]


def repo_commit(graph: Graph) -> Optional[str]:
    try:
        out = subprocess.run(["git", "rev-parse", "HEAD"], cwd=str(graph.root), stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, universal_newlines=True, timeout=20)
        return out.stdout.strip() or None if out.returncode == 0 else None
    except (OSError, subprocess.SubprocessError):
        return None
