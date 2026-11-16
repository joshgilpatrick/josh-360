# Ready checklist result

What the `ready-check` gate returns as `failures`, and what ticket creation's `ticket-complete` gate reads when it runs the same checklist. The checklist items (C1 to C13 for every type, then B, S and R items for Bug, Story and Research) are defined in `docs/superpowers/specs/2026-11-16-triage-graph-design.md`, "The Ready checklist". Once JP-122 builds `ready-check`, the list in that script is the source and the spec says so.

`failures` is a list. Each entry:

| Field | What it holds |
| --- | --- |
| `item` | The checklist id, such as `C6` or `B1` |
| `where` | The section the failure is in (`Acceptance criteria`), or `ticket` for the whole ticket |
| `found` | What the script found, quoted from the ticket and cut to 200 characters, or `missing` |
| `needed` | One sentence: what would pass the item |

An empty list means the outcome is `pass`. No patient data: a failure from the patient-data scan names the item and section only, never the text it matched.
