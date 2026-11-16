---
name: review-ceremony
description: Use when a josh-360 PR comes out of draft, when a review comment lands, when labelling a PR review:needs-agent-audit or review:ready-for-human, when CI goes red on a ready PR, and when deciding whether to merge.
---

# Review ceremony

Rules: `docs/WORKFLOW.md` §4 and §5.

## Publishing thread
1. PR out of draft → add `review:needs-agent-audit`, subscribe to the PR's activity, move the ticket to Code Review, and ask the coordinator for a review thread: PR number, title, URL, head branch, head sha, ticket, your thread link. With no coordinator, run the `ceremony-reviewer` subagent instead.
2. When the review comment lands (it starts `Fixes required: N`), apply every fix under "Fixes". Treat "Not required" items as optional.
3. N > 3: push, put `review:needs-agent-audit` back, ask for another review. N ≤ 3: push, remove `review:needs-agent-audit`, add `review:ready-for-human`, move the ticket to Validation.
4. `review:ready-for-human` starts CI. Wait for the `suite` check. Red: remove the label, fix, push, and go back to step 3 (a code push means `needs-agent-audit` again).
5. Merge only when `docs/WORKFLOW.md` §5 says you may and `suite` is green. After a merge, move the ticket to Done and comment the merge sha, the CI run id and each scenario's proof.

## Review thread
1. Read the PR, its ticket, spec, plan and boards. Run `/code-review` on the PR.
2. Post one PR comment:
   - first line `Fixes required: N`;
   - `## Fixes (real defects)`: numbered, each with file:line, the specific bug, a failure scenario and a suggested fix;
   - `## Not required`: spec-faithful behaviour, optional tidy-ups and process notes; these do not count toward N;
   - a closing line saying what the publishing thread does next (N > 3 another round; N ≤ 3 add `review:ready-for-human`);
   - the Claude Code footer.
3. Never push, label or merge. Tell the coordinator the review is posted, then resolve.

Keep rounds converging: count only real defects, and do not re-raise a choice the spec made.
