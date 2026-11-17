# Route record

What `mark-ready` writes on a Ready ticket, as the Jira issue property `josh360.route`, and what the target graph's `ready` entry gate reads.

| Field | What it holds |
| --- | --- |
| `graph` | `development` or `non-development` |
| `system` | The registry system name (the repository label), or `none` |
| `space` | The Jira space the registry gives the system |
| `version` | The ticket version that was signed off (a hash of summary, description, type, labels and links) |
| `run` | The triage run id |
| `signed_by` | The sign-off session id |
| `returns` | How many times the ticket has come back to triage from another graph since Josh last answered about it. Kept across runs; the third return goes to Josh (spec rule 10). |
| `returns_seen` | How many "Returned to triage" comments the ticket carried when this record was written. The next `mark-ready` counts only the comments after that many as new returns. |
| `returned_from` | The id of the newest "Returned to triage" comment not seen before, or empty for a first route (the return gate records no run id, so the comment id is the stable pointer) |

The record never holds a priority, a rank or anything from `conventions/priorities.yaml`: working agents never see priorities.

The target graph's `ready` gate passes only when the ticket's status is Ready, `graph` names that graph, and the ticket's current version equals `version`. A ticket edited after sign-off is not Ready in fact, so it goes back to triage.
