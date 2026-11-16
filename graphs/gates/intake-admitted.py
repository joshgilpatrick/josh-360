#!/usr/bin/env python3
"""Entry gate of ticket-creation: admits one intake item.

Inputs: GRAPH_INPUT_SOURCE, GRAPH_INPUT_SOURCE_REF.
Outcomes: pass, refused.
Rule: pass only when the item exists at its pointer, comes from a source in the first wave
(email, todo, session, manual), is not dismissed, carries no ticket key yet, and has no
open run (so a second run on the same item is refused, not doubled). A Jira comment or edit is
never an input, so nothing this graph writes can start it again.

Draft stub from the ticket creation design (JP-102, docs/design/ticket-creation-graph.md).
JP-121 builds it. Until then it refuses to run, so no graph can pass through it by accident.
"""
import sys

sys.exit("intake-admitted: not built yet (JP-121)")
