# How work is done here

## Contents

- [1. Tickets](#1-tickets)
- [2. Design](#2-design)
- [3. Build and proof](#3-build-and-proof)
- [4. Review ceremony](#4-review-ceremony)
- [5. Merge and deploy](#5-merge-and-deploy)
- [6. Running the project](#6-running-the-project)

The owner is Josh. Values such as the tracker, statuses and models are in `.claude/workflow.config.md`. When a rule here and an instruction from Josh in a thread differ, Josh's instruction wins; record it here in the next PR so the two agree again.

## 1. Tickets

1. The ticket rules for all of Josh's work are in `conventions/tickets.md`; this section applies them to josh-360. Every bug, feature and improvement has a Jira ticket in `JP` ("Josh Projects") under the epic JP-94, labelled `josh-360`, with a type (the config says what Bug, Feature and Improvement are called here). Questions and one-line doc fixes need none.
2. Acceptance criteria are Gherkin scenarios, each tagged `@auto` (an automated test), `@e2e` (a run of the real app) or `@manual` (Josh checks it). Each scenario becomes its test or its named evidence.
3. Board shape: phase (the `Phase N:` summary prefix), then the epic JP-94, then the ticket. Size a ticket for one design-plan-build cycle; if a reviewer could approve half of it, it is two tickets.
4. A design that needs Josh is its own ticket and **blocks** the build ticket. Blocking links ("is blocked by") in Jira are the gate, not prose.
5. A ticket is `Ready` before work starts: a separate agent signs it off, or sends it back for more input. A Ready ticket has no open questions, except a ticket whose purpose is to produce a spec, design or plan.
6. One branch per ticket, named after its key (`JP-<n>/<slug>` or `JP-<n>-<slug>`; rules in `conventions/tickets.md`, "Branches"), or the session's branch when the platform fixes it. Every session and thread title (a thread, a cloud session, a laptop session) and every PR title starts with the Jira ticket key it covers, then a short name: "JP-105 Connect the laptop"; for several tickets, "JP-12 + JP-14 Sign-in page". Threads with no single ticket, such as Ticket Master, the watchers and the coordinator, keep their role names. Work that needs a ticket gets one first (step 1), then the title; a session that needs none (a question, a one-line doc fix) has no key to prefix. The coordinator sets the title when it starts a thread; a session whose title lacks the key renames itself when it starts the ticket. The PR body has `Fixes JP-n`, or `Part of JP-n` for a partial PR. Jira does not close tickets from PRs here, so the merging thread moves the ticket to Done.
7. **Status lives in Jira, not in the repo.** No status or change-log files. Comment on the ticket on every merge, at the end of every session that changed something, and for every owner decision or check changing colour, in the shape `result | evidence (commit, PR, run id) | next gate`. No secrets or patient data in tickets.
8. Close a ticket by mapping each scenario to its proof (a test file, or a path under `docs/proof/` for `@e2e` and `@manual`).
9. Never invent points, assignees, dates or priorities. Never delete an issue (cancel it instead). Read every Jira write back to confirm it.

## 2. Design

1. For a ticket that needs design: first post your reading of the ticket, the defaults you will draw on, and the one question that changes the build most. Keep drawing on the defaults while you wait.
2. Design questions are collected, each with a recommendation, and put to Josh in one sitting per phase (JP-106 for phase 1). A question that comes up during building, whose answer can be undone, takes the recommended option, is recorded in `docs/decisions.md`, and the work carries on.
3. Mock-up boards first, for anything with a screen, committed to `docs/design/views/<view>/` with a README (file, what the board shows, size). Josh approves the boards.
4. Then the spec, `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`: a screen-to-board table with the line "the boards win on visuals" (when there are boards), the rules, the Gherkin, and what is out of scope. Josh approves the spec.
5. **Josh gates only the boards and the spec.** After approval, the design thread writes the plan straight away (`superpowers:writing-plans`) to `docs/superpowers/plans/YYYY-MM-DD-<topic>.md`, naming the board in every task, commits it, tells the coordinator "plan complete" with the ticket, plan path and branch, and stops. It does not build.
6. After the build, the spec gains an "As built" section listing anything that differs from the design.

## 3. Build and proof

1. A build thread implements the approved plan as written (`superpowers:subagent-driven-development`, test first). It asks the coordinator only if the plan is wrong.
2. Run the full local suite (`python3 scripts/check.py`, plus any suite the config adds) before every push. CI is not a change's first test.
3. **Proof before the PR.** For a change someone sees, run the real app and share fresh screenshots of every touched surface in the thread before the PR opens. For a change with no screen, share the command or test output that proves each scenario. Commit proof under `docs/proof/YYYY-MM-DD/JP-n/`, then post screenshots on the PR as a comment with markdown image syntax and `raw.githubusercontent.com` URLs. One image per comment, or tile them into contact sheets. Read the comment back; if a URL came back wrapped in backticks, edit the comment with the same body.
4. A PR that is ready is out of draft. A draft means a blocker, and the thread says what it is.
5. Threads resolve merge conflicts on their own PRs without asking, unless picking a side changes behaviour Josh must decide. Before numbering a database migration, read the latest one on `main` and in other open PRs.
6. Every PR body starts with the project attribution block when the platform gives one, and Josh is assigned and asked to review. Every comment posted on GitHub ends with the Claude Code footer.
7. Work in the cloud first, on made-up sample data. A step that must run on Josh's laptop is named in the ticket in advance.

## 4. Review ceremony

1. When a PR comes out of draft, the publishing thread adds the label `review:needs-agent-audit`, subscribes to the PR's activity, and in the same step asks the coordinator for a review thread (PR number, title, head sha, ticket, its own thread link). The ticket moves to `Code Review`.
2. The review thread runs `/code-review` on the PR against the ticket, spec, plan and boards, and posts **one** PR comment that starts `Fixes required: N`. Each fix gives file:line, the bug and a suggested fix. Spec-faithful behaviour and optional tidy-ups go under "Not required" and do not count. The reviewer never pushes, labels or merges.
3. The publishing thread applies the fixes. N > 3: it adds `review:needs-agent-audit` again and asks for another review. N ≤ 3 (including 0): it adds `review:ready-for-human`, removes the other label, and moves the ticket to `Validation`.
4. `review:ready-for-human` starts the PR's CI run. Merge only when the `suite` check is green. On a red run, the publishing thread removes the label, fixes and pushes. Any code push after `ready-for-human` goes back to `needs-agent-audit`.
5. A watcher polls hourly for the `needs-agent-audit` label as a backup, and never asks twice for the same PR and head sha.
6. The review comment posts under Josh's GitHub account, so it may not wake the publishing thread. The coordinator tells it when the review lands.

## 5. Merge and deploy

1. In josh-360, the publishing thread merges its own PR once the whole ceremony is done and `suite` is green: the build thread for features, the fix thread for bugs. It then moves the ticket to Done and comments on it. No sign-off from Josh is needed. A bug that needs a design call goes to Josh first. PRs to Josh's other repositories wait for the phase close.
2. Merging to `main` is the install: within about 10 minutes the laptop moves its copy to `main`, runs `laptop/install.py` and reports on the `laptop-status` branch (JP-105). Read it with `python3 laptop/status.py show` and check it after merging anything that runs on the laptop. Threads never install by hand. To stop installs, push a branch named `laptop-pause`.
3. These need Josh's confirmation in the thread each time: a permanent deletion (files, branches with unmerged work, tickets, data) and a write to a shared database or an app other people use. Permanent deletions wait in one list per phase. Never write a passphrase or secret anywhere.
4. Never a test or deploy target: any Eventus production database or shared app.

## 6. Running the project

1. Every thread keeps a visible checklist and replies only with a result, a blocker or a question.
2. A thread that waits for Josh is a stalled thread. Do what can be undone and say what you did. Ask only for steps that cannot be undone and for real product choices, once, with a recommendation and a free-text route.
3. Models: design and planning on `claude-opus-5-5`; code, fixes, reviews and watchers on `claude-sonnet-5-5`. The coordinator passes the model when it starts a thread.
4. Watchers are silent unless they act. Each keeps its rules, a handled list and a short run log in one memory file, pruned to stay small.
5. Durable facts go to project memory in the turn they are learned: one file per subject, indexed in `MEMORY.md`. Rules go here, in this file, not only in memory.
6. CI spend: PR CI runs only at `review:ready-for-human` (once per PR) and on pushes to `main`. Docs and Markdown changes run it too, because the suite checks them.
