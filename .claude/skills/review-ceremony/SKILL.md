---
name: review-ceremony
description: Use when a josh-360 PR comes out of draft, when a review comment lands, when labelling a PR review:needs-agent-audit or review:ready-for-human, when CI goes red on a ready PR, and when deciding whether to merge.
---

# Review ceremony

Rules: `docs/WORKFLOW.md` §4 and §5.

## Publishing thread
1. PR out of draft → add `review:needs-agent-audit`, subscribe to the PR's activity, move the ticket to Code Review. That label is the request: Josh's laptop automation audits the PR and comments. Do not ask the coordinator for a review thread.
2. When the audit comment lands (it moves the label through `review:audit-in-progress` to `review:changes-requested` or `review:ready-for-human`), apply every finding and reply on the PR. A finding you decline still counts toward N; state the reason. `review:audit-blocked` means it needs Josh: tell him in your thread.
3. N > 3: push, put `review:needs-agent-audit` back for another round. N ≤ 3: push, remove the other review labels, add `review:ready-for-human` if the audit did not, move the ticket to Validation.
4. `review:ready-for-human` starts CI. It does not wait for Josh. Wait for the `suite` check. Red: remove the label, fix, push, and go back to step 3 (a code push means `needs-agent-audit` again). A push that only merges `main` in, or only applies the audit's own findings (N ≤ 3), keeps `ready-for-human`: remove and re-add the label to rerun CI.
5. On a green `suite`, merge in the same turn (`docs/WORKFLOW.md` §5; design, build, fix and workflow PRs alike). Then move the ticket to Done, comment the merge sha, the CI run id and each scenario's proof, and resolve your thread. Never leave a green `ready-for-human` PR open for Josh.

The audit runs only while Josh's laptop is on. If none has landed after 4 hours, keep working on what you can; the Project Manager lists the PR for Josh. Use the `ceremony-reviewer` subagent only if Josh asks for a cloud review.

Keep rounds converging: count only real defects, and do not re-raise a choice the spec made.
