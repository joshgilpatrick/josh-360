"""The start rules, read against Jira (JP-117). Python 3.9, standard library only.

`graphs/runner/starts.json` says, per graph, which tickets get a run. This module judges it: it searches Jira with the
rule's JQL, reads each ticket's route record and spec property, builds the graph's inputs, and asks the walker to
start the run. It never decides anything about the graph itself, and it writes nothing to Jira.

Unknown is not empty: a failed search starts nothing, and an unreadable property skips that one ticket.
"""
from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path
from typing import Dict, Optional

from . import ledgerview, paths, walk
from ledger import jira_read  # noqa: E402
from lib import jira_fake  # noqa: E402  (graphs/gates/lib, on sys.path through paths)
from lib.jira import Jira, JiraError  # noqa: E402
from lib.triage.port import ROUTE_PROPERTY, SPEC_PROPERTY  # noqa: E402

RULES = paths.HERE / "starts.json"
FIELDS = ["issuetype", "status", "labels"]
SEARCH_LIMIT = 50


class MissingInput(Exception):
    """An input with no value and no default. The message is the input's name."""


def load_rules(path: Path = RULES) -> dict:
    """The rules file, checked. Raises ValueError naming the entry that is not the shape a rule needs."""
    doc = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(doc, dict) or not isinstance(doc.get("per_pass"), int) or doc["per_pass"] < 1:
        raise ValueError("starts: per_pass must be a whole number of at least 1")
    graphs = doc.get("graphs")
    if not isinstance(graphs, dict):
        raise ValueError("starts: graphs must be an object")
    for name, rule in graphs.items():
        if not isinstance(rule, dict) or not isinstance(rule.get("on"), bool):
            raise ValueError("starts: '{}' needs an 'on' of true or false".format(name))
        if not rule.get("on"):
            continue
        if not isinstance(rule.get("jql"), str) or not rule["jql"].strip():
            raise ValueError("starts: '{}' is on and has no jql".format(name))
        no_record = rule.get("route_record") is False
        if not no_record and (not isinstance(rule.get("route"), str) or not rule["route"]):
            raise ValueError("starts: '{}' is on and has no route (a rule with no route record says "
                             "\"route_record\": false)".format(name))
        inputs = rule.get("inputs")
        if not isinstance(inputs, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in inputs.items()):
            raise ValueError("starts: '{}' needs inputs as an object of name to source".format(name))
        if no_record:
            if "route" in rule:
                raise ValueError("starts: '{}' reads no route record, so it cannot name a route".format(name))
            for source in inputs.values():
                if source.startswith(("route.", "spec.")):
                    raise ValueError("starts: '{}' reads no route record or spec, so '{}' has nothing to read".format(
                        name, source))
    return doc


def jira_client(environ: dict, run=subprocess.run) -> Optional[Jira]:
    """A Jira client, or None when there are no credentials (never `gate_io.fail`, which would exit). The email and the
    token are found the way the rest of the laptop finds them: the environment, then the email file and the keychain."""
    if jira_fake.folder_from(environ) is not None:
        return Jira.from_env(environ)
    found = jira_read.credentials(environ, run)
    if found is None:
        return None
    email, token = found
    return Jira.from_env(dict(environ, JOSH360_JIRA_EMAIL=email, JOSH360_JIRA_TOKEN=token))


def _empty(value: object) -> bool:
    return value is None or value == ""


def _source(source: str, issue: dict, route: dict, spec: Optional[dict], last_run: Optional[str]) -> object:
    if source == "issuetype":
        return ((issue.get("fields") or {}).get("issuetype") or {}).get("name")
    if source == "last_run":
        return last_run
    if source.startswith("route."):
        return (route or {}).get(source[len("route."):])
    if source.startswith("spec."):
        return (spec or {}).get(source[len("spec."):])
    return None


def build_inputs(mapping: dict, issue: dict, route: dict, spec: Optional[dict], last_run: Optional[str]) -> Dict[str, str]:
    """Each input's value from its source (`<source>` or `<source>|<default>`). Raises MissingInput(name)."""
    out: Dict[str, str] = {}
    for name, rule in mapping.items():
        source, _, default = rule.partition("|")
        value = _source(source, issue, route, spec, last_run)
        if _empty(value):
            if "|" not in rule:
                raise MissingInput(name)
            value = default
        out[name] = ("true" if value else "false") if isinstance(value, bool) else str(value)
    return out


def _jql(rule: dict) -> str:
    jql = rule["jql"].strip()
    return jql if re.search(r"\bORDER\s+BY\b", jql, re.I) else jql + " ORDER BY Rank ASC"


def watch(conn, jira: Optional[Jira], rules: dict, root: Optional[Path] = None) -> dict:
    """One pass over every graph that is on. Returns {graph: {"jira", "started": [keys], "skipped": {key: reason}}}."""
    result: dict = {}
    started_total = 0
    for graph, rule in rules["graphs"].items():
        if not rule.get("on"):
            continue
        entry = {"jira": "ok", "started": [], "skipped": {}}
        result[graph] = entry
        if jira is None:
            entry["jira"] = "no-credentials"
            continue
        try:
            issues = jira.search(_jql(rule), FIELDS, SEARCH_LIMIT)
        except JiraError:
            issues = None
        if issues is None:
            entry["jira"] = "unknown"
            continue
        for issue in issues:
            if started_total >= rules["per_pass"]:
                break
            key = issue.get("key")
            reason = _try_start(conn, jira, graph, rule, issue, root)
            if reason is None:
                entry["started"].append(key)
                started_total += 1
            else:
                entry["skipped"][key] = reason
    return result


def _try_start(conn, jira: Jira, graph: str, rule: dict, issue: dict, root: Optional[Path]) -> Optional[str]:
    """None when a run started, else the reason (one of a fixed list: no ticket text reaches the report)."""
    key = issue.get("key")
    if ledgerview.ticket_has_open_run(conn, key):
        return "has an open run"
    if rule.get("route_record") is False:      # the validation rule: the ticket's state alone says it is wanted
        route, spec, state = {}, None, "none"
    else:
        state, route = jira.read_property(key, ROUTE_PROPERTY)
        if state == "unknown":
            return "route record unreadable"
        if state != "set" or not isinstance(route, dict):
            return "no route record"
        if route.get("graph") != rule["route"]:
            return "routed elsewhere"
        state, spec = jira.read_property(key, SPEC_PROPERTY)
        if state == "unknown":
            return "spec unreadable"
        if state == "set" and not isinstance(spec, dict):
            return "spec does not parse"
    last = ledgerview.last_ended_run(conn, key, graph) if not _empty(route.get("returned_from")) else None
    try:
        inputs = build_inputs(rule["inputs"], issue, route, spec if state == "set" else None, last)
    except MissingInput as err:
        return "missing input {}".format(err)
    argv = ["start", "--graph", graph, "--ticket", key, "--runner", "agent-manager"]
    for name, value in inputs.items():
        argv += ["--input", "{}={}".format(name, value)]
    if inputs.get("phi") == "true":
        argv.append("--phi")
    try:
        walk.call(*argv, root=root)
    except walk.WalkerRefused as err:
        paths.log("start of {} for {} refused: {}".format(graph, key, str(err)[:200]))
        return "not admitted"
    return None
