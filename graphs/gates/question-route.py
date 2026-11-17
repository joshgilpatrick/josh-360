#!/usr/bin/env python3
"""Gate question-route (JP-115): where a designer's question goes.

`to_triage` for a build ticket (a Story, Bug or Task goes back to triage, which answers from its sources first), `to_josh`
for a Research ticket, whose questions are its work. No Jira call: the ticket type is an input.

Outcomes: to_triage, to_josh. Inputs: ticket_type.
"""
from lib.gate_run import execute, need


def run(inputs, deps):
    research = need(inputs, "ticket_type") == "Research"
    return ("to_josh" if research else "to_triage"), None, "a Research ticket's question is Josh's" if research \
        else "a build ticket's question goes back to triage"


if __name__ == "__main__":
    execute(run, ["ticket_type"])
