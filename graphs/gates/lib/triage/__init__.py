"""The parts of the triage and sign-off graph that need no Jira and no model (JP-122).

Python 3.9, standard library only: the gate scripts run on the laptop. Each module is a pure function or a small
reader, tested against made-up tickets (graphs/tests/test_triage_*.py). The gate scripts in graphs/gates/ are thin
shells around them. Design: docs/superpowers/specs/2026-11-16-triage-graph-design.md.

    ticket.py     a ticket as the checklist reads it: sections in order, version hash
    gherkin.py    finding and reading the Gherkin block
    checklist.py  the Ready checklist, C1 to C13, B1, B2, S1, R1, R2
    route.py      the routing table
    signoff.py    the defect filter and the author check
    verdict.py    combining the results and the return budget
    copy.py       every comment the graph writes, word for word
    port.py       reading a ticket and its history from Jira, writing nothing
    registry.py   the repository registry, from conventions/registry.json
    runs.py       what the walker's run folders say (open runs, Josh's answers) and the ledger (signing session)
    times.py      Jira timestamps
"""
# Agent Status is a custom field. The ids are action-triage's (src/core/jira/config.ts, DEFAULT_JIRA_PROJECTS):
# AD is customfield_10452 and JP is customfield_10453. The entry gate reads the changelog for either.
AGENT_STATUS_FIELDS = ("customfield_10453", "customfield_10452")
QUEUED = "Queued"
# The label that says a Ready ticket may be run (Josh, 18 November 2026): until he turns sprints on for JP, the label
# is the start signal. The runner's start rule (graphs/runner/starts.json) names the same label.
RUN_LABEL = "ready-to-run"

TRIAGE_TYPES = ("Story", "Task", "Bug", "Research")
RETURN_BUDGET = 2          # a ticket may come back to triage twice; the third return of an own ticket goes to Josh
DRAFTER_ROUNDS = 2         # the loop limit in graphs/flows/triage.yaml, for the round count in the comment
