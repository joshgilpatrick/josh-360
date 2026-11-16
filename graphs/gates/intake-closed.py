#!/usr/bin/env python3
"""Exit gate of ticket-creation.

Inputs: GRAPH_INPUT_SOURCE_REF, GRAPH_INPUT_TICKET_KEYS.
Outcomes: pass, open.
Rule: pass when the item ended one of three ways: every proposed ticket exists, reads back, has a
parent or an area, and is linked from the source; or the open match was commented on; or Josh
dropped it. Anything else is open and goes back to Josh.

Draft stub from the ticket creation design (JP-102, docs/design/ticket-creation-graph.md).
JP-121 builds it. Until then it refuses to run, so no graph can pass through it by accident.
"""
import sys

sys.exit("intake-closed: not built yet (JP-121)")
