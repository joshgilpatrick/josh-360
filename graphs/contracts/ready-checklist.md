# Ready checklist result

What the `ready-check` gate returns as `failures`, and what ticket creation's `ticket-complete` gate reads when it runs the same checklist. The checklist items are C1 to C13 for every type, then B1 and B2 (Bug), S1 (Story) and R1 and R2 (Research). The list in `graphs/gates/lib/triage/checklist.py` is the source; the design is in `docs/superpowers/specs/2026-11-16-triage-graph-design.md`, "The Ready checklist".

`failures` is a list. Each entry:

| Field | What it holds |
| --- | --- |
| `item` | The checklist id, such as `C6` or `B1` |
| `where` | The section the failure is in (`Acceptance criteria`), or `ticket` for the whole ticket |
| `found` | What the script found, quoted from the ticket and cut to 200 characters, or `missing` |
| `needed` | One sentence: what would pass the item |

An empty list means the outcome is `pass`. No patient data: a failure from the patient-data scan names the item and section only, never the text it matched.
