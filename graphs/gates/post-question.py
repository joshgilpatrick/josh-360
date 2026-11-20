#!/usr/bin/env python3
"""Gate 'post-question' (JP-122): put the one question on the ticket before Josh is asked.

Inputs: ticket_key, proposal (the drafter's `needs_josh` result, graphs/contracts/ticket-proposal.md, "A revision").
Outcomes: posted. The spec's exact copy for the question comment is written once, screened for patient data, and a run
that crashed after posting does not post it twice. It changes nothing else: the walker sets the flag when the ask opens.
Outputs (JP-199): `card`, the question and the recommendation as the Needs you card shows them, and `options`, the
recommendation as an answer Josh can choose there.
"""
from lib import contracts
from lib.gate_run import GateError, execute, need, say
from lib.triage import copy
from lib.triage.port import CommentPort


def run(inputs, deps):
    key = need(inputs, "ticket_key")
    try:
        ask = contracts.load_question(inputs.get("proposal"))
    except contracts.ContractError as exc:
        raise GateError("the question is not in the contract: {}".format(exc))
    run_id = deps.environ.get("JOSH360_RUN_ID") or "unknown"
    text = copy.question(run_id, ask["question"], ask["recommendation"], ask["reason"])
    say(CommentPort(deps.jira), key, text, once=True)
    outputs = {"card": copy.card(ask["question"], ask["recommendation"], ask["reason"]),
               "options": [{"label": ask["recommendation"].strip(), "description": copy.recommended(ask["reason"])}]}
    return "posted", outputs, "the question is on the ticket and on the card"


if __name__ == "__main__":
    execute(run, ["ticket_key", "proposal"])
