# Ready checklist result

What the `ready-check` gate returns as `failures`, and what ticket creation's `ticket-complete` gate reads when it runs the same checklist. The checklist items are C1 to C13 for every type, then B1 and B2 (Bug), S1 (Story), R1 and R2 (Research) and V1 to V7 (the Validation section of a Story, Task or Bug; `validation-section.md`). The list in `graphs/gates/lib/triage/checklist.py` is the source; the design is in `docs/superpowers/specs/2026-11-16-triage-graph-design.md`, "The Ready checklist".

`failures` is a list. Each entry:

| Field | What it holds |
| --- | --- |
| `item` | The checklist id, such as `C6`, `B1` or `V3` |
| `where` | The section the failure is in (`Acceptance criteria`, `Validation`), or `ticket` for the whole ticket |
| `found` | What the script found, quoted from the ticket and cut to 200 characters, or `missing` |
| `needed` | One sentence: what would pass the item |

The V items come from the Validation section parser (`graphs/gates/lib/validation_section.py`): V1 no section or no `Needed:` line, V2 a `Needed: no` that gives too short a reason or carries other lines, V3 a timetable line missing or not in its form, V4 no `@validate` scenario or no measured one, V5 a collector or argument that is not on the list, V6 a field, comparison or value that does not fit, V7 a timetable that cannot finish. `needed` names the form to write.

An empty list means the outcome is `pass`. No patient data: a failure from the patient-data scan names the item and section only, never the text it matched.
