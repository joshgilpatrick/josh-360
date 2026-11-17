# Intake record

## Contents

- [What it is](#what-it-is)
- [Fields](#fields)
- [Example](#example)

## What it is

The structured form of one loose input (a forwarded email, a Notion action item, a to-do, or a session's request for a ticket). The `intake-reader` role writes it at the start of the ticket creation graph; every later step reads these fields instead of the raw input. It lives with the run and never leaves the ticket creation graph: later graphs read the ticket itself. Design: `docs/design/ticket-creation-graph.md`.

No patient data. The raw input stays where it came from, named by `source_ref`.

## Fields

JSON, one object in a file (the gates run on the laptop's Python, which has no YAML reader). `basis` says where a value came from: `stated` (the input says it), `inferred` (the reader worked it out), or `unresolved`. A field marked with `basis` may be written as text or as `{"value": ..., "basis": ...}`.

| Field | Type | Required | What it holds |
| --- | --- | --- | --- |
| `source` | text | yes | `email`, `notion`, `todo`, `session` or `manual` |
| `source_ref` | text | yes | A pointer to the input: desk thread id, action item id, to-do id, session id. Never the text itself. |
| `requester` | text | yes | Who asked. Josh, unless the input names someone else. |
| `request` | text | yes | The request restated plainly, as a verb and a deliverable, in one or two sentences. |
| `deliverable` | text | yes | What exists when the work is done (a pull request, an answer, a file, a draft), with `basis`. |
| `ticket_type` | text | yes | `Story`, `Task`, `Bug`, `Research`, `Epic` or `unclear`. |
| `work_kind` | text | yes | `code`, `doc`, `research`, `email`, `meeting`, `misc` or `unclear` (action-triage's list). |
| `weight` | text | yes | `light` or `full`. |
| `repository` | text | no | A repository name from the registry, with `basis`; empty when none fits. |
| `folder` | text | no | A folder from the input, when it names one. |
| `named_space`, `named_parent` | text | no | A space or ticket key the input names outright. |
| `entities` | list | no | Systems, cohorts, date ranges, facilities, file names, as words, never patient details. |
| `deadline` | text | no | Only when the input states one. |
| `search_terms` | list | yes | The request's own words and the synonyms a matching ticket might use. |
| `unresolved` | list | yes | Each gap the reader could not close, in one sentence. Empty when none. |
| `contains_patient_data` | boolean | yes | `true` when the input holds patient data; the record then refers to it only by `source_ref`. |

## Example

Made-up data.

```json
{
  "source": "todo",
  "source_ref": "todo/2026-11-16/0007",
  "requester": "Josh",
  "request": "Add a dry-run flag to the laptop install script so a change can be previewed.",
  "deliverable": {
    "value": "a merged pull request in josh-360",
    "basis": "inferred"
  },
  "ticket_type": "Story",
  "work_kind": "code",
  "weight": "light",
  "repository": {
    "value": "josh-360",
    "basis": "stated"
  },
  "search_terms": [
    "dry run",
    "install preview",
    "laptop install",
    "install.py flag"
  ],
  "unresolved": [],
  "contains_patient_data": false
}
```
