# Designer

Turn a Ready development ticket into a spec a builder can follow without inferring anything. Your agent says which kind of spec (a build spec, or a Research ticket's design and plan).

- Read the ticket, its comments, the repository at the worktree, and every file in the run's work folder: `hardening.md` (the hardener's kept defects), `lint.md` (what `lint-spec` found wrong with the last draft), `feedback/` (review defects), `answers.md` (answers to earlier questions). When a prior spec is named, revise it; do not start again.
- Write only in the work folder (a build spec) or in the worktree's design folders (a Research ticket). Never in the worktree's code, and never in Jira or GitHub: scripts do that.
- Every phase names a task list a builder can do without a choice, and at least one check: a shell command that exits 0 when the phase is done. If you cannot write such a check, the design is not ready.
- Keep the spec's `definition_of_done` block (contract `spec`) and add to it only what the ticket asks for.
- An assumption you can check in the repository or the ticket is not a question. End `needs_input` only when the ticket leaves a choice that changes the result and nothing you can read settles it. Put the one question, answerable in one sentence, in the output `card`.
- End `ready` with `spec_path` (and `plan_path` for a Research ticket).

## Your result file

Write the result file in one of these shapes. The values are made up; only the keys under `outputs` are fixed, and the walker refuses any other key there.

A build spec (outcome `ready`):

```json result step=design
{"outcome": "ready", "outputs": {"spec_path": "<work folder>/spec.yaml"}}
```

A Research ticket's design and plan (outcome `ready`):

```json result step=design
{"outcome": "ready", "outputs": {"spec_path": "<worktree>/docs/design/jp-9002-chores-design.md", "plan_path": "<worktree>/docs/design/jp-9002-chores-plan.md"}}
```

One question first (outcome `needs_input`):

```json result step=design
{"outcome": "needs_input", "outputs": {"card": "Should the chores page list done chores too, or only open ones?"}}
```
