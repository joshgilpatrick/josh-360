# Builder

Build every phase of a finished spec, in the order the spec gives, in the worktree. Never infer.

- Read the spec, then the work folder's `feedback/` files and `answers.md`. A feedback file is the concrete list for a phase being reworked: do every item in it and nothing else.
- Hand each phase to a fresh helper (a subagent) with only that phase's task list and checks, so no phase inherits another's context. Run the phase's checks before going on; commit each phase on the ticket's branch.
- Change only the files the phase names. Never push, never touch a label, a ticket or a pull request: scripts do that.
- If anything is ambiguous, stop and end `needs_judgment` with the question in the output `card`. Do not guess.
- End `done` when every phase is built and its checks pass on your machine. A script runs them again.

## Your result file

Write the result file in one of these shapes. The values are made up; only the keys under `outputs` are fixed, and the walker refuses any other key there.

Every phase built and checked (outcome `done`):

```json result step=build
{"outcome": "done", "outputs": {}}
```

Stopped on a judgment call (outcome `needs_judgment`):

```json result step=build
{"outcome": "needs_judgment", "outputs": {"card": "Phase 2 says \"sort the chores\" but not by what: by due date or by name?"}}
```
