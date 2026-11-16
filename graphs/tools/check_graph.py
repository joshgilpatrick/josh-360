#!/usr/bin/env python3
"""Check agent graph files against graphs/CONVENTION.md (JP-101).

Usage:
  python3 graphs/tools/check_graph.py                  every graph in <root>/flows/
  python3 graphs/tools/check_graph.py FILE [FILE ...]  only these graph files
  --root DIR                                           the parts folder (default: graphs/)

It checks tiers.yaml, every role and agent under the root, and each graph file. One line per problem,
then a summary line. Exit 0: no problems. Exit 1: problems. Exit 2: cannot run.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

try:
    import yaml
except ImportError:  # reported in main(), so the tests and the suite say what to install
    yaml = None

CONVENTION = 1
TIERS = ("cheap", "mid", "gate")
ACCESS = ("read", "josh", "shared")
LEDGER = ("run", "step", "outcome", "loop_count", "session", "tier", "ticket", "started_at", "ended_at")
EFFECTS = ("move_ticket", "set_label")
TYPES = ("string", "number", "boolean", "list")
EFFORTS = ("low", "medium", "high")
HEADER_FIELDS = ("jira", "entry_gate", "exit_gate", "asks_josh", "ledger", "access")

# Keys that belong to one runner. They are refused by name, so the message says where they go instead.
ORCHESTRATOR_KEYS = {
    "manager", "mode", "isolation", "providers", "provider", "model", "models", "thinking", "effort",
    "timeout", "worktree", "permission_mode", "permissionMode", "bypassPermissions", "playbook",
    "playbooks", "paseo", "agent_manager", "agentManager", "mcp", "mcpServers", "allowedTools", "tools",
    "subagent_type", "max_turns", "cwd", "env", "group", "session_name", "spawn",
}

# --- Schema: which keys may appear where -------------------------------------------------------------
LEAF = None


def MAP(value):  # a mapping whose keys are names (inputs, step ids); its values follow `value`
    return ("map", value)


def LIST(item):
    return ("list", item)


def EITHER(shape):  # a scalar, or a mapping shaped like `shape`
    return ("either", shape)


IO = {"type": LEAF, "required": LEAF, "default": LEAF, "description": LEAF}
OUTPUT = {"type": LEAF, "description": LEAF, "contract": LEAF}
GOTO = {"goto": LEAF, "max_loops": LEAF, "at_limit": LEAF}
STEP = {
    "id": LEAF, "role": LEAF, "agent": EITHER({"by": LEAF, "map": MAP(LEAF), "default": LEAF}),
    "tier": LEAF, "brief": LEAF, "gate": LEAF, "effects": LEAF,
    "ask": {"question": LEAF, "choices": LEAF, "approves": LEAF, "approves_on": LEAF, "on_limit_only": LEAF},
    # inputs is a list of names; a mapping is wrong, and every key in it is reported (EITHER of no keys).
    "needs": LEAF, "when": {"step": LEAF, "outcome": LEAF}, "inputs": EITHER({}), "outputs": MAP(OUTPUT),
    "outcomes": LEAF, "on": MAP(EITHER(GOTO)),
}
HEADER = {
    "jira": LIST({"status": LEAF, "steps": LEAF}), "entry_gate": LEAF, "exit_gate": LEAF,
    "asks_josh": LEAF, "ledger": LEAF, "access": MAP(LEAF),
}
GRAPH = {
    "convention": LEAF, "graph": LEAF, "title": LEAF, "description": LEAF, "header": HEADER,
    "inputs": MAP(IO), "outputs": MAP(IO), "steps": LIST(STEP),
}
# The schema accepts a bare name here; load_parts() below refuses any entry with no effort (JP-138).
TIER_ENTRY = EITHER({"model": LEAF, "effort": LEAF})
TIERS_FILE = {"convention": LEAF, "tiers": {t: LIST(TIER_ENTRY) for t in TIERS}, "max_runs": LEAF}
ROLE_FILE = {"title": LEAF, "may_change": LEAF, "tier": LEAF, "reviewer": LEAF}
AGENT_FILE = {"title": LEAF, "fills": LEAF}


def schema_problems(node, shape, path: str = "") -> list[str]:
    """Every key outside the convention's schema, with its path (steps are named by their id)."""
    out: list[str] = []
    if shape is LEAF:
        return out
    if isinstance(shape, tuple):
        kind, inner = shape
        if kind == "map" and isinstance(node, dict):
            for key, value in node.items():
                out += schema_problems(value, inner, f"{path}.{key}" if path else str(key))
        elif kind == "list" and isinstance(node, list):
            for i, item in enumerate(node):
                name = item.get("id") if isinstance(item, dict) and isinstance(item.get("id"), str) else None
                out += schema_problems(item, inner, f"{path}.{name}" if name else f"{path}[{i}]")
        elif kind == "either" and isinstance(node, dict):
            out += schema_problems(node, inner, path)
        return out
    if not isinstance(node, dict):
        return out
    for key, value in node.items():
        where = f"{path}.{key}" if path else str(key)
        if key in shape:
            out += schema_problems(value, shape[key], where)
        elif key in ORCHESTRATOR_KEYS:
            out.append(f"{where}: key '{key}' belongs to one orchestrator; put it in graphs/bindings/<tool>/")
        else:
            out.append(f"{where}: key '{key}' is not in the convention's schema")
    return out


# --- YAML: no surprise booleans, no silent duplicate keys --------------------------------------------
class GraphYamlError(Exception):
    pass


if yaml is not None:
    class _Loader(yaml.SafeLoader):
        """SafeLoader that reads on/off/yes/no as words and refuses a key written twice."""

        def construct_mapping(self, node, deep=False):
            seen = set()
            for key_node, _ in node.value:
                key = self.construct_object(key_node, deep=deep)
                if key in seen:
                    raise GraphYamlError(f"line {key_node.start_mark.line + 1}: key '{key}' appears twice")
                seen.add(key)
            return super().construct_mapping(node, deep=deep)

    _Loader.yaml_implicit_resolvers = {
        first: [(tag, rx) for tag, rx in resolvers if tag != "tag:yaml.org,2002:bool"]
        for first, resolvers in yaml.SafeLoader.yaml_implicit_resolvers.items()
    }
    _Loader.add_implicit_resolver(
        "tag:yaml.org,2002:bool",
        __import__("re").compile(r"^(?:true|True|TRUE|false|False|FALSE)$"),
        list("tTfF"),
    )


def load_yaml(path: Path):
    try:
        return yaml.load(path.read_text(encoding="utf-8"), Loader=_Loader)
    except yaml.YAMLError as exc:
        raise GraphYamlError(f"not valid YAML: {exc}".replace("\n", " ")) from exc
    except TypeError as exc:  # a list or mapping used as a key cannot be held in a mapping
        raise GraphYamlError(f"a key must be a plain word, not a list or mapping ({exc})") from exc


def _is_text(value) -> bool:
    return isinstance(value, str) and value.strip() != ""


def _str_list(value) -> bool:
    return isinstance(value, list) and all(isinstance(v, str) for v in value)


TEMPLATE = __import__("re").compile(r"\{\{\s*inputs\.([A-Za-z0-9_]+)\s*\}\}")


def _names(value) -> list[str]:
    """A list of names, or [] when the value is not one (its own check reports that)."""
    return value if _str_list(value) else []


# --- Parts: tiers, roles, agents, gates, contracts ---------------------------------------------------
class Parts:
    def __init__(self, root: Path):
        self.root = root
        self.roles: dict[str, dict] = {}
        self.agents: dict[str, dict] = {}
        self.gates: set[str] = set()
        self.contracts: set[str] = set()
        self.max_runs: dict[str, int] = {}  # tier -> most runs of one role step in one graph run (JP-139)
        self.problems: list[str] = []


def _load_part(parts: Parts, path: Path, shape: dict, required: tuple) -> dict | None:
    rel = path.relative_to(parts.root).as_posix()
    if not path.is_file():
        parts.problems.append(f"{rel}: missing")
        return None
    try:
        data = load_yaml(path)
    except GraphYamlError as exc:
        parts.problems.append(f"{rel}: {exc}")
        return None
    if not isinstance(data, dict):
        parts.problems.append(f"{rel}: must be a mapping")
        return None
    parts.problems += [f"{rel}: {p}" for p in schema_problems(data, shape)]
    parts.problems += [f"{rel}: missing field '{f}'" for f in required if f not in data]
    return data


def _instructions(parts: Parts, folder: Path) -> None:
    text = folder / "instructions.md"
    if not text.is_file() or not text.read_text(encoding="utf-8").strip():
        parts.problems.append(f"{folder.relative_to(parts.root).as_posix()}: instructions.md is missing or empty")


def load_parts(root: Path) -> Parts:
    parts = Parts(root)
    tiers = _load_part(parts, root / "tiers.yaml", TIERS_FILE, ("convention", "tiers"))
    if tiers is not None:
        if tiers.get("convention") != CONVENTION:
            parts.problems.append(f"tiers.yaml: convention must be {CONVENTION}")
        table = tiers.get("tiers") if isinstance(tiers.get("tiers"), dict) else {}
        for tier in TIERS:
            entries = table.get(tier)
            if tier not in table:
                parts.problems.append(f"tiers.yaml: tier '{tier}' is missing")
            elif not isinstance(entries, list) or not entries:
                parts.problems.append(f"tiers.yaml: tier '{tier}' needs a list of one or more models")
            else:
                for i, entry in enumerate(entries):
                    model = entry.get("model") if isinstance(entry, dict) else entry
                    effort = entry.get("effort") if isinstance(entry, dict) else None
                    if not _is_text(model):
                        parts.problems.append(f"tiers.yaml: tiers.{tier}[{i}] needs a model name")
                    if effort is None:
                        parts.problems.append(
                            f"tiers.yaml: tiers.{tier}[{i}] is missing an effort (one of {', '.join(EFFORTS)}); "
                            f"every entry is {{model: <name>, effort: <level>}}")
                    elif effort not in EFFORTS:
                        parts.problems.append(f"tiers.yaml: tiers.{tier}[{i}].effort must be one of {', '.join(EFFORTS)}")

        caps = tiers.get("max_runs") if isinstance(tiers.get("max_runs"), dict) else {}
        if "max_runs" in tiers and not isinstance(tiers["max_runs"], dict):
            parts.problems.append("tiers.yaml: max_runs must map each tier to a number of runs")
        for name in caps:
            if name not in TIERS:
                parts.problems.append(f"tiers.yaml: max_runs.{name} is not a tier (one of {', '.join(TIERS)})")
        for tier in TIERS:
            cap = caps.get(tier)
            if cap is None:
                parts.problems.append(f"tiers.yaml: tier '{tier}' has no max_runs")
            elif isinstance(cap, bool) or not isinstance(cap, int) or cap < 1:
                parts.problems.append(f"tiers.yaml: max_runs.{tier} must be a whole number of 1 or more")
            else:
                parts.max_runs[tier] = cap

    for folder in sorted(p for p in (root / "roles").glob("*") if p.is_dir()):
        role = _load_part(parts, folder / "role.yaml", ROLE_FILE, ("title", "may_change", "tier"))
        _instructions(parts, folder)
        if role is None:
            continue
        rel = f"roles/{folder.name}/role.yaml"
        if "may_change" in role and not isinstance(role["may_change"], bool):
            parts.problems.append(f"{rel}: may_change must be true or false")
        if "reviewer" in role and not isinstance(role["reviewer"], bool):
            parts.problems.append(f"{rel}: reviewer must be true or false")
        if "tier" in role and role["tier"] not in TIERS:
            parts.problems.append(f"{rel}: tier must be one of {', '.join(TIERS)}")
        if role.get("tier") == "gate" and role.get("may_change") is True:
            parts.problems.append(f"{rel}: the gate tier is for roles that only read and judge")
        parts.roles[folder.name] = role

    for folder in sorted(p for p in (root / "agents").glob("*") if p.is_dir()):
        agent = _load_part(parts, folder / "agent.yaml", AGENT_FILE, ("title", "fills"))
        _instructions(parts, folder)
        if agent is None:
            continue
        if "fills" in agent and (not isinstance(agent["fills"], str) or agent["fills"] not in parts.roles):
            parts.problems.append(f"agents/{folder.name}/agent.yaml: fills unknown role '{agent['fills']}'")
        parts.agents[folder.name] = agent

    parts.gates = {p.stem for p in (root / "gates").glob("*") if p.is_file() and p.suffix in (".py", ".sh")}
    parts.contracts = {p.stem for p in (root / "contracts").glob("*.md") if p.name != "README.md"}
    return parts


# --- Graph files -------------------------------------------------------------------------------------
def _ancestors(steps: dict[str, dict]) -> dict[str, set[str]] | None:
    """Every step's transitive needs, or None when the needs form a cycle."""
    memo: dict[str, set[str]] = {}
    visiting: set[str] = set()

    def visit(sid: str) -> set[str] | None:
        if sid in memo:
            return memo[sid]
        if sid in visiting:
            return None
        visiting.add(sid)
        found: set[str] = set()
        for parent in _names(steps[sid].get("needs")):
            if parent in steps:
                above = visit(parent)
                if above is None:
                    return None
                found |= {parent} | above
        visiting.discard(sid)
        memo[sid] = found
        return found

    for sid in steps:
        if visit(sid) is None:
            return None
    return memo


def _reruns(steps: dict[str, dict], source: str, target: str) -> set[str]:
    """The steps a loop from `source` back to `target` runs again: the target and every step that
    depends on it (the convention's words), except the steps that need `source`, which cannot have run
    yet because they wait for it to finish. Cycle-safe: a cycle in needs is reported elsewhere."""
    children: dict[str, list[str]] = {sid: [] for sid in steps}
    for sid, s in steps.items():
        for parent in _names(s.get("needs")):
            if parent in children:
                children[parent].append(sid)

    def below(start: str) -> set[str]:
        seen: set[str] = set()
        todo = [start]
        while todo:
            for child in children.get(todo.pop(), []):
                if child not in seen:
                    seen.add(child)
                    todo.append(child)
        return seen

    return ({target} | below(target)) - below(source)


def _check_header(header, steps, kind, parts) -> list[str]:
    out: list[str] = []
    if not isinstance(header, dict):
        return ["header: missing or not a mapping"]
    out += [f"header: missing field '{f}'" for f in HEADER_FIELDS if f not in header]

    if "jira" in header:
        stretches = header["jira"] if isinstance(header["jira"], list) else []
        if not stretches:
            out.append("header.jira: needs a list of {status, steps}")
        placed: dict[str, int] = {}
        for i, stretch in enumerate(stretches):
            if not isinstance(stretch, dict) or not _is_text(stretch.get("status")) or not _str_list(stretch.get("steps")):
                out.append(f"header.jira[{i}]: needs a status and a list of steps")
                continue
            for sid in stretch["steps"]:
                if sid not in steps:
                    out.append(f"header.jira: unknown step '{sid}'")
                placed[sid] = placed.get(sid, 0) + 1
        for sid in steps:
            if placed.get(sid, 0) == 0 and stretches:
                out.append(f"header.jira: step '{sid}' is in no stretch")
            elif placed.get(sid, 0) > 1:
                out.append(f"header.jira: step '{sid}' is in more than one stretch")

    for field in ("entry_gate", "exit_gate"):
        if field in header and (not isinstance(header[field], str) or header[field] not in parts.gates):
            out.append(f"header.{field} names unknown gate '{header[field]}'")

    if "asks_josh" in header:
        listed = header["asks_josh"] if _str_list(header["asks_josh"]) else []
        if not _str_list(header["asks_josh"]):
            out.append("header.asks_josh: needs a list of step ids")
        for sid in listed:
            if kind.get(sid) != "ask":
                out.append(f"header.asks_josh: '{sid}' is not an ask step")
        for sid, k in kind.items():
            if k == "ask" and sid not in listed:
                out.append(f"header.asks_josh: ask step '{sid}' is not listed")

    if "ledger" in header:
        ledger = header["ledger"]
        if not _str_list(ledger) or not ledger:
            out.append("header.ledger: needs a list of fields")
        else:
            out += [f"header.ledger: '{f}' is not one of {', '.join(LEDGER)}" for f in ledger if f not in LEDGER]

    if "access" in header:
        access = header["access"] if isinstance(header["access"], dict) else {}
        if not isinstance(header["access"], dict):
            out.append("header.access: needs a mapping of step id to read, josh or shared")
        for sid, value in access.items():
            if sid not in steps:
                out.append(f"header.access: unknown step '{sid}'")
            elif value not in ACCESS:
                out.append(f"header.access.{sid}: '{value}' is not one of {', '.join(ACCESS)}")
        out += [f"header.access: step '{sid}' has no access" for sid in steps if isinstance(header["access"], dict) and sid not in access]
    return out


def check_graph_data(data, name: str, parts: Parts) -> list[str]:
    """Every problem in one graph file's data. `name` is the file name without .yaml."""
    if not isinstance(data, dict):
        return ["the file must be a mapping"]
    out = schema_problems(data, GRAPH)
    out += [f"missing field '{f}'" for f in ("convention", "graph", "title", "description", "header", "steps") if f not in data]
    if "convention" in data and data["convention"] != CONVENTION:
        out.append(f"convention must be {CONVENTION}")
    if "graph" in data and data["graph"] != name:
        out.append(f"graph '{data['graph']}' does not match the file name '{name}'")
    for field in ("title", "description"):
        if field in data and not _is_text(data[field]):
            out.append(f"{field} must be text")
    graph_inputs = data.get("inputs") if isinstance(data.get("inputs"), dict) else {}
    for key in ("inputs", "outputs"):
        for io_name, io in (data.get(key) or {}).items() if isinstance(data.get(key), dict) else []:
            if not isinstance(io, dict) or io.get("type") not in TYPES:
                out.append(f"{key}.{io_name}: type must be one of {', '.join(TYPES)}")

    raw = data.get("steps")
    if not isinstance(raw, list) or not raw:
        out.append("steps: needs a list of one or more steps")
        raw = []
    steps: dict[str, dict] = {}
    for i, s in enumerate(raw):
        if not isinstance(s, dict) or not _is_text(s.get("id")):
            out.append(f"steps[{i}]: needs an id")
        elif s["id"] in steps:
            out.append(f"step id '{s['id']}' is used twice")
        else:
            steps[s["id"]] = s

    kind: dict[str, str] = {}
    outcomes: dict[str, list] = {}
    for sid, s in steps.items():
        kinds = [k for k in ("role", "gate", "ask") if k in s]
        if len(kinds) != 1:
            out.append(f"step '{sid}' must have exactly one of role, gate or ask")
            continue
        kind[sid] = kinds[0]
        if kinds[0] == "ask":
            ask = s["ask"] if isinstance(s["ask"], dict) else {}
            outcomes[sid] = ask.get("choices") if _str_list(ask.get("choices")) else []
            if not _is_text(ask.get("question")):
                out.append(f"ask step '{sid}' needs a question")
            if not outcomes[sid]:
                out.append(f"ask step '{sid}' needs a list of choices")
            if "outcomes" in s:
                out.append(f"ask step '{sid}' takes its outcomes from its choices")
        else:
            outcomes[sid] = s.get("outcomes") if _str_list(s.get("outcomes")) else []
            if not outcomes[sid]:
                out.append(f"step '{sid}' needs a list of outcomes")

    limit_targets: set[str] = set()
    for sid, s in steps.items():
        k = kind.get(sid)
        for key in ("agent", "tier", "brief"):
            if key in s and k != "role":
                out.append(f"step '{sid}': {key} only goes on a role step")
        if "effects" in s and k != "gate":
            out.append(f"step '{sid}': only a gate script may have effects (set labels, move tickets)")
        if k == "role":
            role_name = s["role"] if isinstance(s["role"], str) else None
            role = parts.roles.get(role_name) if role_name else None
            if role_name is None:
                out.append(f"step '{sid}': role must be a name")
            elif role is None:
                out.append(f"step '{sid}' names unknown role '{role_name}'")
            agent = s.get("agent")
            named: list[str] = []
            if isinstance(agent, str):
                named = [agent]
            elif isinstance(agent, dict):
                if not isinstance(agent.get("by"), str) or agent.get("by") not in graph_inputs:
                    out.append(f"step '{sid}': agent rule reads '{agent.get('by')}', which is not a graph input")
                rule_map = agent.get("map") if isinstance(agent.get("map"), dict) else {}
                named = list(rule_map.values()) + ([agent["default"]] if "default" in agent else [])
                if not all(isinstance(a, str) for a in named):
                    out.append(f"step '{sid}': agent rule map values must be agent names")
                    named = [a for a in named if isinstance(a, str)]
            elif agent is not None:
                out.append(f"step '{sid}': agent must be a name or a rule")
            for a in named:
                if a not in parts.agents:
                    out.append(f"step '{sid}' names unknown agent '{a}'")
                elif role is not None and parts.agents[a].get("fills") != role_name:
                    out.append(f"step '{sid}': agent '{a}' fills role '{parts.agents[a].get('fills')}', not '{role_name}'")
            if "tier" in s:
                if s["tier"] not in TIERS:
                    out.append(f"step '{sid}': tier must be one of {', '.join(TIERS)}")
                elif role is not None and role.get("tier") in TIERS and TIERS.index(s["tier"]) > TIERS.index(role["tier"]):
                    out.append(f"step '{sid}': tier '{s['tier']}' is above its role's tier '{role['tier']}'")
        elif k == "gate":
            if not isinstance(s["gate"], str):
                out.append(f"step '{sid}': gate must be a name")
            elif s["gate"] not in parts.gates:
                out.append(f"step '{sid}' names unknown gate '{s['gate']}'")
            effects = s.get("effects", [])
            if not _str_list(effects):
                out.append(f"step '{sid}': effects must be a list")
            else:
                out += [f"step '{sid}': effect '{e}' is not one of {', '.join(EFFECTS)}" for e in effects if e not in EFFECTS]
        elif k == "ask":
            ask = s["ask"] if isinstance(s["ask"], dict) else {}
            approves = ask.get("approves", [])
            if not _str_list(approves):
                out.append(f"ask step '{sid}': approves must be a list of step ids")
            out += [f"ask step '{sid}' approves unknown step '{a}'" for a in _names(approves) if a not in steps]
            if "on_limit_only" in ask and not isinstance(ask["on_limit_only"], bool):
                out.append(f"ask step '{sid}': on_limit_only must be true or false")
            if ask.get("on_limit_only") is True and ("needs" in s or "when" in s):
                out.append(f"ask step '{sid}' is on_limit_only, so it takes no needs or when")
            if _names(approves):
                choices = _names(ask.get("choices"))
                yes = ask.get("approves_on")
                if "approves_on" not in ask:
                    out.append(f"ask step '{sid}' approves steps, so it needs approves_on")
                elif not _str_list(yes) or not yes:
                    out.append(f"ask step '{sid}': approves_on must be a list of its choices")
                else:
                    out += [f"ask step '{sid}': approves_on choice '{c}' is not one of its choices"
                            for c in yes if c not in choices]
                    if choices and set(choices) <= set(yes):
                        out.append(f"ask step '{sid}': approves_on must name some of its choices, not all of them")
                if "when" in s:
                    out.append(f"ask step '{sid}' approves a shared write, so it takes no when "
                               "(a skipped approval is not a yes)")
                if ask.get("on_limit_only") is True:
                    out.append(f"ask step '{sid}' approves steps, so it cannot be on_limit_only")
            elif "approves_on" in ask:
                out.append(f"ask step '{sid}': approves_on only goes with approves")

        needs = s.get("needs", [])
        if not _str_list(needs):
            out.append(f"step '{sid}': needs must be a list of step ids")
        else:
            out += [f"step '{sid}' needs unknown step '{n}'" for n in needs if n not in steps]

        when = s.get("when")
        if when is not None:
            target = when.get("step") if isinstance(when, dict) else None
            wanted = when.get("outcome") if isinstance(when, dict) else None
            wanted = [wanted] if isinstance(wanted, str) else wanted
            if not isinstance(target, str) or target not in steps:
                out.append(f"step '{sid}': when names unknown step '{target}'")
            elif not _str_list(wanted) or not wanted:
                out.append(f"step '{sid}': when needs an outcome")
            else:
                out += [f"step '{sid}': when names outcome '{o}', which step '{target}' does not have"
                        for o in wanted if o not in outcomes.get(target, [])]

        for field, text in (("brief", s.get("brief")), ("question", s["ask"].get("question")
                                                         if isinstance(s.get("ask"), dict) else None)):
            for name in TEMPLATE.findall(text) if isinstance(text, str) else []:
                if name not in graph_inputs:
                    out.append(f"step '{sid}': {field} names '{{{{ inputs.{name} }}}}', which is not a graph input")

        if "inputs" in s and not _str_list(s["inputs"]):
            out.append(f"step '{sid}': inputs must be a list of names")

        for key, output in (s.get("outputs") or {}).items() if isinstance(s.get("outputs"), dict) else []:
            if not isinstance(output, dict) or output.get("type") not in TYPES:
                out.append(f"step '{sid}' output '{key}': type must be one of {', '.join(TYPES)}")
            contract = output.get("contract") if isinstance(output, dict) else None
            if contract is not None and (not isinstance(contract, str) or contract not in parts.contracts):
                out.append(f"step '{sid}' output '{key}' names unknown contract '{contract}'")

        on = s.get("on") or {}
        for outcome, then in on.items() if isinstance(on, dict) else []:
            if outcome not in outcomes.get(sid, []):
                out.append(f"step '{sid}': on '{outcome}' is not one of its outcomes")
            if then == "end":
                continue
            if not isinstance(then, dict) or "goto" not in then:
                out.append(f"step '{sid}': on '{outcome}' must be end or a goto")
                continue
            if not isinstance(then["goto"], str) or not isinstance(then.get("at_limit", ""), str):
                out.append(f"step '{sid}': on '{outcome}': goto and at_limit must be step ids")
                continue
            loop = f"loop {sid} -> {then['goto']} (outcome '{outcome}')"
            if then["goto"] not in steps:
                out.append(f"{loop} goes to unknown step '{then['goto']}'")
            if "max_loops" not in then:
                out.append(f"{loop} has no max_loops")
            elif isinstance(then["max_loops"], bool) or not isinstance(then["max_loops"], int) or then["max_loops"] < 1:
                out.append(f"{loop}: max_loops must be a whole number of 1 or more")
            if "at_limit" not in then:
                out.append(f"{loop} has no at_limit, so it does not end at a human")
            elif kind.get(then["at_limit"]) != "ask":
                out.append(f"{loop}: at_limit '{then['at_limit']}' is not an ask step, so the loop does not end at a human")
            else:
                limit_targets.add(then["at_limit"])
            # The run cap (JP-139): one more run than max_loops, for every role step the loop runs again.
            if then["goto"] in steps and isinstance(then.get("max_loops"), int) and not isinstance(then["max_loops"], bool) \
                    and then["max_loops"] >= 1:
                runs = then["max_loops"] + 1
                for rid in sorted(_reruns(steps, sid, then["goto"])):
                    rerun_role = parts.roles.get(steps[rid]["role"]) if kind.get(rid) == "role" \
                        and isinstance(steps[rid].get("role"), str) else None
                    tier = steps[rid].get("tier") if steps[rid].get("tier") in TIERS else \
                        (rerun_role or {}).get("tier")
                    cap = parts.max_runs.get(tier) if tier in TIERS else None
                    if cap is not None and runs > cap:
                        out.append(f"{loop} would run step '{rid}' {runs} times (max_loops {then['max_loops']} + 1) "
                                   f"against a {tier} cap of {cap}")

    for sid, s in steps.items():
        if kind.get(sid) == "ask" and isinstance(s["ask"], dict) and s["ask"].get("on_limit_only") is True \
                and sid not in limit_targets:
            out.append(f"ask step '{sid}' is on_limit_only but no loop ends at it")

    out += _check_header(data.get("header"), steps, kind, parts)

    # The habits that need the whole graph.
    access = data.get("header", {}).get("access") if isinstance(data.get("header"), dict) else None
    access = access if isinstance(access, dict) else {}
    above = _ancestors(steps)
    if above is None:
        out.append("needs form a cycle")
    for sid, s in steps.items():
        role = parts.roles.get(s["role"]) if kind.get(sid) == "role" and isinstance(s["role"], str) else None
        if role is not None and access.get(sid) in ("josh", "shared") and role.get("may_change") is False:
            out.append(f"step '{sid}' writes (access '{access[sid]}') but role '{s['role']}' may not change things")
        if role is not None and role.get("reviewer") is True:
            cited = any(kind.get(o) == "gate" and sid in _names(other.get("needs")) for o, other in steps.items())
            if not cited:
                out.append(f"step '{sid}' uses reviewer role '{s['role']}' but no gate step needs it to drop defects "
                           "that do not cite the plan")
        if kind.get(sid) == "gate" and _names(s.get("effects")) and access.get(sid) == "read":
            out.append(f"step '{sid}' has effects, so its access cannot be read")
        if above is not None and _str_list(s.get("inputs")):
            available = set(graph_inputs)
            for a in above[sid]:
                if isinstance(steps[a].get("outputs"), dict):
                    available |= set(steps[a]["outputs"])
            out += [f"step '{sid}' reads unknown input '{n}'" for n in s["inputs"] if n not in available]
        if access.get(sid) == "shared" and above is not None:
            approvers = [a for a in sorted(above[sid]) if kind.get(a) == "ask" and isinstance(steps[a]["ask"], dict)
                         and sid in _names(steps[a]["ask"].get("approves"))]
            when = s.get("when") if isinstance(s.get("when"), dict) else {}
            if not approvers:
                out.append(f"step '{sid}' writes something shared and no approval step comes before it")
            elif when.get("step") not in approvers:
                out.append(f"step '{sid}' writes something shared but does not run only when '{approvers[0]}' "
                           "is answered with an approving choice")
            else:
                yes = _names(steps[when["step"]]["ask"].get("approves_on"))
                wanted = [when.get("outcome")] if isinstance(when.get("outcome"), str) else _names(when.get("outcome"))
                out += [f"step '{sid}' runs on '{o}', which is not one of {when['step']}'s approves_on choices"
                        for o in wanted if o not in yes]
    return out


# --- Command line ------------------------------------------------------------------------------------
def _shown(path: Path) -> str:
    try:
        return path.resolve().relative_to(Path.cwd().resolve()).as_posix()
    except ValueError:
        return str(path)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Check agent graph files against graphs/CONVENTION.md.")
    parser.add_argument("files", nargs="*", type=Path, help="graph files (default: every <root>/flows/*.yaml)")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent,
                        help="the parts folder holding tiers.yaml, roles/, agents/, gates/ and contracts/")
    args = parser.parse_args(argv)

    if yaml is None:
        print("check_graph: cannot run: PyYAML is not installed (pip install -r requirements.txt)")
        return 2
    if not args.root.is_dir():
        print(f"check_graph: cannot run: no folder {args.root}")
        return 2
    files = args.files or sorted((args.root / "flows").glob("*.yaml"))
    missing = [f for f in files if not f.is_file()]
    if missing:
        print(f"check_graph: cannot run: no file {', '.join(map(str, missing))}")
        return 2

    parts = load_parts(args.root)
    problems = [f"{_shown(args.root)}/{p}" for p in parts.problems]
    for path in files:
        try:
            found = check_graph_data(load_yaml(path), path.stem, parts)
        except GraphYamlError as exc:
            found = [str(exc)]
        problems += [f"{_shown(path)}: {p}" for p in found]

    for p in problems:
        print(p)
    status = f"FAILED ({len(problems)} problem(s) in {len(files)} graph(s))" if problems else f"ok ({len(files)} graph(s))"
    print(f"check_graph: {status}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
