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
| `returned_from` | The run id of the graph that sent the ticket back, or empty for a first route |

The record never holds a priority, a rank or anything from `conventions/priorities.yaml`: working agents never see priorities.

The target graph's `ready` gate passes only when the ticket's status is Ready, `graph` names that graph, and the ticket's current version equals `version`. A ticket edited after sign-off is not Ready in fact, so it goes back to triage.
