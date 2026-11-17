# Ticket proposal

## Contents

- [What it is](#what-it-is)
- [Fields](#fields)
- [Example](#example)

## What it is

The tickets a ticket creation run wants to write, or the comment it wants to post on an open match. The `ticket-drafter` role writes it, the `ticket-complete` gate checks it, the approval card shows it to Josh, and the `create-tickets` script writes exactly what was approved. Design: `docs/design/ticket-creation-graph.md`.

No patient data in any field.

## Fields

JSON, one object in a file (the gates run on the laptop's Python, which has no YAML reader).

| Field | Type | What it holds |
| --- | --- | --- |
| `action` | text | `create` or `comment_on_match` |
| `match` | mapping | `key`, `status` and, for `comment_on_match`, `request` (the request restated in one or two sentences; the script wraps it in the fixed comment text from the design, so the drafter never writes the comment itself). For `create` after a Done or Cancelled match: the old key, linked with Relates. |
| `shape` | text | `single`, `parent_with_subtasks` or `epic_with_tickets` |
| `route` | mapping | `space`, `parent` (key or null), `area`, `system`, `labels`, and `rule` (which routing rule decided: named, repository, folder or fallback) |
| `tickets` | list | One entry per ticket, parent first. Each has `ref` (a local name such as `t1`, since keys do not exist yet), `type`, `summary`, `work_kind`, `sections` (Josh's format for its type, in order), `parent_ref` or `parent`, `links` (a list of `{"kind": "blocked_by" | "blocks" | "relates", "target": <a ref or a key>}`), `repository`, `where_it_runs` |
| `inferred` | list | Every value the drafter inferred rather than copied, as `<ref>.<field>`, so the card can mark it |
| `gaps` | list | Open questions for Josh, one sentence each. A proposal with gaps never reaches the approval card. |
| `authors` | list | Session ids of the steps that wrote this proposal (intake, decompose, draft), for the `josh360.authors` property |

## Example

Made-up data.

```json
{
  "action": "create",
  "shape": "single",
  "route": {
    "space": "JP",
    "parent": "JP-94",
    "area": null,
    "system": "josh-360",
    "labels": [
      "josh-360"
    ],
    "rule": "repository"
  },
  "tickets": [
    {
      "ref": "t1",
      "type": "Story",
      "summary": "Add a dry-run flag to the laptop install script",
      "work_kind": "code",
      "repository": "josh-360",
      "where_it_runs": "Cloud session",
      "sections": {
        "goal": "laptop/install.py --dry-run prints every step it would take and changes nothing.",
        "first_step": "Read STEPS in laptop/install.py.",
        "why": "Josh wants to preview an install before it runs.",
        "in_scope": [
          "A --dry-run flag on laptop/install.py"
        ],
        "not_in_scope": [
          "Changing what an install does"
        ],
        "acceptance_criteria": "Feature: Install dry run\n  @auto\n  Scenario: Nothing changes\n    Given a laptop copy at the last good commit\n    When install.py runs with --dry-run\n    Then it lists each step and the copy is unchanged\n",
        "parent_or_related": "Parent: JP-94",
        "decisions_already_made": []
      }
    }
  ],
  "inferred": [
    "t1.where_it_runs",
    "t1.first_step"
  ],
  "gaps": [],
  "authors": [
    "session-a",
    "session-b"
  ]
}
```
