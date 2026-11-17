#!/usr/bin/env python3
"""Entry gate of ticket-creation: admits one intake item.

Inputs: GRAPH_INPUT_SOURCE, GRAPH_INPUT_SOURCE_REF.
Outcomes: pass, refused.
Rule: pass only when the item exists at its pointer, comes from a source in the first wave (email, todo, session,
manual), is not dismissed, carries no ticket key yet, and has no open run (so a second run on the same item is
refused, not doubled). A Jira comment or edit is never an input, so nothing this graph writes can start it again.
A store that cannot be read is unknown, not empty: the item is refused and the summary says why.

Built in JP-121 from the design in docs/design/ticket-creation-graph.md.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from lib import sources  # noqa: E402
from lib.gate_io import finish, read_inputs  # noqa: E402


def decide(source, source_ref):
    source = (source or "").strip().lower()
    source_ref = (source_ref or "").strip()
    if source not in sources.FIRST_WAVE:
        return "refused", f"source '{source}' is not in the first wave ({', '.join(sources.FIRST_WAVE)})"
    if not source_ref or len(source_ref) > 200 or any(c.isspace() for c in source_ref):
        return "refused", "source_ref must be a short pointer with no spaces, never the text itself"
    state = sources.item_state(source, source_ref)
    if not state["known"]:
        return "refused", "the source store cannot be read, so the item cannot be admitted"
    if not state["exists"]:
        return "refused", "no item exists at that pointer"
    if state["dismissed"]:
        return "refused", "the item was dismissed"
    if state["ticket_key"]:
        return "refused", f"the item already carries ticket {state['ticket_key']}"
    if state["open_run"]:
        return "refused", "another ticket-creation run on this item has not ended"
    return "pass", "admitted"


if __name__ == "__main__":
    values = read_inputs(["source", "source_ref"])
    outcome, summary = decide(values["source"], values["source_ref"])
    finish(outcome, summary=summary)
