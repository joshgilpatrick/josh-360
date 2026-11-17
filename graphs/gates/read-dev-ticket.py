#!/usr/bin/env python3
"""Gate read-dev-ticket (JP-115): is this ticket one the development graph can work, and where is its repository?

The ticket is trusted over the inputs: the status, route record, type, flag and Agent Status are read from Jira, and an
input that disagrees is a refusal. `not_here` carries one fixed sentence as its `reason` and nothing from the ticket,
so a refusal can be posted anywhere. A clone missing on this machine is a GateError (the machine's fault, not the
ticket's). When `resume_from` names an earlier run that returned a question, its saved spec comes back as `prior_spec`.

Outcomes: build (Story, Bug, Task), design_only (Research), not_here. Inputs: ticket_key, ticket_type, system, resume_from.
"""
import json
import re
from pathlib import Path

from lib import dev_git
from lib.gate_run import GateError, execute, need
from lib.ticket_text import parse_sections

TYPES = ("Story", "Bug", "Task", "Research")
BULLET = re.compile(r"^\s*(?:[-*•]|\d+[.)])\s+(.*\S)\s*$")
RUN_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


def _not_here(reason):
    return "not_here", {"reason": reason}, reason


def _has_open_question(description):
    section = parse_sections(description).get("Open questions", "")
    for line in section.splitlines():
        found = BULLET.match(line)
        if found and not found.group(1).lower().startswith("answered:"):
            return True
    return False


def _system_entry(deps, name):
    try:
        systems = json.loads(Path(deps.registry_path).read_text(encoding="utf-8")).get("systems") or []
    except (OSError, ValueError):
        raise GateError("the registry could not be read")
    for system in systems:
        if str(system.get("name", "")).lower() == name.lower() and system.get("repositories"):
            return system
    return None


def _prior_spec(deps, resume_from):
    run = (resume_from or "").strip()
    if not run or not RUN_ID.match(run):
        return "none"
    base = Path(deps.runs_dir) / run
    spec = base / "work" / "spec.yaml"
    if spec.is_file():
        return str(spec)
    saved = sorted((p for p in (base / "saved").glob("*spec_path*") if p.is_file()),
                   key=lambda p: (p.stat().st_mtime, p.name))
    return str(saved[-1]) if saved else "none"


def run(inputs, deps):
    key = need(inputs, "ticket_key")
    given_type = need(inputs, "ticket_type")
    system = need(inputs, "system")
    if not re.match(r"^JP-\d+$", key):
        return _not_here("the development graph works JP tickets only")
    try:
        ticket = deps.ticket.read(key)
    except GateError:
        return _not_here("the ticket could not be read")
    if ticket.status != "Ready":
        return _not_here("the ticket is not Ready")
    route = ticket.route or {}
    if route.get("graph") != "development":
        return _not_here("the ticket is not routed to the development graph")
    kind = next((t for t in TYPES if t.lower() == (ticket.issuetype or "").lower()), None)
    if kind is None or kind.lower() != given_type.lower():
        return _not_here("the ticket type is not one the development graph builds")
    entry = _system_entry(deps, system)
    named = route.get("system")
    if entry is None or (named and str(named).lower() != system.lower()):
        return _not_here("the ticket's system has no repository in the registry")
    if ticket.flagged or _has_open_question(ticket.description):
        return _not_here("the ticket has an open question")
    if deps.ticket.agent_status(key) not in (None, "Finished"):
        return _not_here("another runner holds the ticket")
    try:
        clone = dev_git.clone_for(deps.registry_path, entry["repositories"][0], deps.environ)
        repo = dev_git.owner_repo(clone)
    except dev_git.GitError as exc:
        raise GateError(str(exc))
    outputs = {"repo": repo, "prior_spec": _prior_spec(deps, inputs.get("resume_from"))}
    return ("design_only" if kind == "Research" else "build"), outputs, "{} ticket for {}".format(kind, repo)


if __name__ == "__main__":
    execute(run, ["ticket_key", "ticket_type", "system", "resume_from"])
