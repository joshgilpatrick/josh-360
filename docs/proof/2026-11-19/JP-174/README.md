# JP-174 proof: one branch and one worktree per ticket, and leftovers in plain sight

## Contents

- [What changed](#what-changed)
- [Scenario to proof](#scenario-to-proof)
- [Sandbox laptop run](#sandbox-laptop-run)
- [What has not run on the real laptop](#what-has-not-run-on-the-real-laptop)

## What changed

- A graph step's session can no longer make a second worktree or a new branch. The guard (`graphs/runner/runner_lib/hooklib.py`, rules in `runner_lib/gitrail.py`) refuses `git worktree add`, `claude --worktree`, the `EnterWorktree` tool, `git checkout -b`, `git switch -c` and `git branch <new>`, and its message names the ticket's own branch and worktree, read from the run's `prepare-worktree` outputs.
- `runner.py where <KEY>` and the published report's `tickets` rows say `Worktree kept: <path> on branch <branch>` for a run that ended or stopped with the ticket's worktree still on disk (`worktree_kept` in the JSON).
- The doctor has a new check, `graphs.stale-worktrees`: it warns for each `.claude/worktrees/<KEY>-*` folder in a registered clone whose ticket has no open run and whose last run ended more than 7 days ago.
- `ledger/loose_ends.py` has a seventh kind, `closed-pr-branch`: a remote ticket branch whose pull request was closed without merging. `/closeout` puts it to Josh and never deletes it; `keep` now accepts a remote-only branch.

Choices made while building: `docs/decisions/JP-174.md`.

## Scenario to proof

| Scenario | Tag | Proof |
| --- | --- | --- |
| A step session tries to make a second worktree | `@auto` | `tests/test_worktree_rail.py` `test_a_second_worktree_is_refused_and_the_message_names_the_ticket_s_own`; sandbox step `02-rail-worktree.json` |
| A step session tries to cut a new branch | `@auto` | `tests/test_worktree_rail.py` `test_a_new_branch_is_refused`; sandbox step `02-rail-checkout.json` |
| Committing on the ticket's branch still works | `@auto` | `tests/test_worktree_rail.py` `test_committing_on_the_ticket_s_branch_is_not_refused`; sandbox step `02-rail-commit.json` (exit 0) |
| A stopped run says it kept its worktree | `@auto` | `tests/test_worktree_kept.py` `test_a_stopped_run_says_it_kept_its_worktree` (and the published row and cloud answer in `test_the_published_report_and_the_cloud_answer_carry_it`) |
| The doctor finds a stale worktree | `@auto` | `tests/test_doctor_stale_worktrees.py` `test_a_worktree_left_8_days_after_its_run_warns_and_one_left_6_days_does_not`; sandbox step `03-doctor-graphs.json` |
| A closed PR's remote branch is a loose end | `@auto` | `tests/test_loose_ends_closed_pr.py` `test_a_closed_pull_request_s_remote_branch_is_listed_with_fetch` |

The Validation section's two `@validate` scenarios (doctor `graphs.stale-worktrees` is pass; job `doctor` exits 0 within 26 hours) are watched on the laptop by the validation graph once the ticket is in Deployed.

## Sandbox laptop run

`verify-josh-360/` holds a run of the `verify-josh-360` sandbox at this branch's commit (19 November 2026): `launch-install.json` and `doctor.json` are the sandbox's own launch and baseline doctor (`"ok": true`).

- `01-setup-made-up-state.json` runs `setup.py` (copied here): it makes a registered clone `~/Development/active/josh_360` with three folders under `.claude/worktrees/`, writes three made-up graph runs into the sandbox ledger (JP-902 ended 8 days ago, JP-906 ended 6 days ago, JP-900 still open), and a run folder and linked build step session for JP-900. The session entry is written by hand, in the shape the link hook writes, because a real link needs Agent Manager.
- `02-rail-worktree.json`, `02-rail-checkout.json`, `02-rail-commit.json` fire the real `PreToolUse` hook through `hooks/dispatch` with the payloads `pre-*.json`: the first two exit 2 with a message naming `JP-900-login` and its worktree; the commit exits 0.
- `03-doctor-graphs.json` runs `scripts/doctor.py --only graphs --json`: `graphs.stale-worktrees` is `warn` and names `JP-902-x` only (JP-906's run ended 6 days ago; JP-900 has an open run).

## What has not run on the real laptop

Everything above ran on made-up data. After the merge, the laptop installs on its own; the checks owed there are: `python3 laptop/status.py show doctor` lists `graphs.stale-worktrees` (pass, or warn naming real leftovers for Josh to look at with `/closeout`), and the validation watch for this ticket starts once it is in Deployed.
