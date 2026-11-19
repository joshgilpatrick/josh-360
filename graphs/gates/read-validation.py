#!/usr/bin/env python3
"""Gate read-validation (JP-167): read the ticket's Validation section with the one parser, and say what it holds.

No model. The section is read from the ticket's marked text (the ```gherkin fence is part of it), fresh on every round,
so an edit to the criteria between rounds counts.

Outcomes: watch (Needed: yes and every line readable), not_needed (Needed: no, or no section), unreadable (a line the
parser could not read, or no `Needed:` answer). Inputs: ticket_key.
Outputs: needed (yes, no or unreadable), criteria, starts, check_every_hours, complete_when, give_up_days, fail_after,
section_version, problems (each line the script could not read, and what would pass). On unreadable the timetable
outputs are whatever was read.
"""
from lib import validation_section
from lib.gate_run import GateError, execute, need
from lib.triage.ticket import description_text

OUTPUTS = ("criteria", "starts", "check_every_hours", "complete_when", "give_up_days", "fail_after", "section_version",
           "problems")


def run(inputs, deps):
    key = need(inputs, "ticket_key")
    issue = deps.jira.get(key)
    if issue is None:
        raise GateError("{} could not be read from Jira".format(key))
    section = validation_section.parse(description_text((issue.get("fields") or {}).get("description")), key)
    outcome = validation_section.route(section)
    outputs = {name: section[name] for name in OUTPUTS if section.get(name) is not None}
    outputs["needed"] = {"watch": "yes", "not_needed": "no"}.get(outcome, "unreadable")
    outputs.setdefault("problems", [])
    outputs.setdefault("criteria", [])
    summary = {"watch": "{} criteria to watch".format(len(section["criteria"])),
               "not_needed": "nothing to watch: " + ("no Validation section" if not section["present"] else "Needed: no"),
               "unreadable": "{} line(s) could not be read".format(len(section["problems"]))}[outcome]
    return outcome, outputs, summary


if __name__ == "__main__":
    execute(run, ["ticket_key"])
