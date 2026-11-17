# JP-109 proof: compute loose ends and add the closeout agent

## Contents

- [Scenarios](#scenarios)
- [Each kind of loose end](#each-kind-of-loose-end)
- [A run on a made-up laptop](#a-run-on-a-made-up-laptop)
- [What still needs the laptop](#what-still-needs-the-laptop)

## Scenarios

Every repository in these tests is real git in a temporary folder (an `origin.git`, a clone, branches, worktrees), and every session, ticket and pull request is made up. Jira and GitHub answers are fakes. No real transcript, repository or ticket is read.

| Scenario | Proof | Test |
| --- | --- | --- |
| A clean session has none | `01-clean-session-has-none.txt` | `Scenarios.test_a_clean_session_has_none` |
| Unpushed work is found (names the session, the folder and the branch) | `02-unpushed-work-is-found.txt` | `Scenarios.test_unpushed_work_is_found` |
| A branch kept on purpose is not listed | `03-kept-branch-not-listed.txt` | `Scenarios.test_a_branch_kept_on_purpose_is_not_listed` |
| Closeout never destroys work, and asks before any permanent deletion | `04-closeout-never-destroys-work.txt` | `Closeout.test_closeout_never_destroys_work` (`tests/test_closeout.py`), with `test_every_deletion_is_left_to_josh_or_guarded`, `test_a_phi_folder_is_left_to_josh`, `test_no_force_flag_in_the_script` |
| Skipping the system costs nothing | `05-skipping-costs-nothing.txt` | `Scenarios.test_skipping_the_system_costs_nothing` (also: the schema test `LooseEndsAreNotStored` still passes) |
| Only the laptop's work is listed | `06-only-the-laptops-work.txt` | `Scenarios.test_only_the_laptops_work_is_listed` |

The tests are in `tests/test_loose_ends.py`, `tests/test_closeout.py` and `tests/test_live.py`, with the made-up laptop in `tests/loose_helpers.py`.

## Each kind of loose end

Josh's definition, one test each in `tests/test_loose_ends.py` (class `Kinds`): commits on no branch or pull request, a local branch with no remote branch (and a pushed branch with more local commits), a ticket that is not Done, an open pull request, a leftover worktree (resolved to its main checkout, including one whose folder is gone), and an orphaned branch (merged and left, or pushed and forgotten; not one in use or under an open pull request). A read that fails (no `gh`, Jira down, a folder gone, a commit gone from git) is listed under "could not check" and never read as clean. `ask.py changes --live` now adds the ticket's status and the pull request's state (`tests/test_ledger_ask.py`).

## A run on a made-up laptop

`07-demo-run-on-a-made-up-laptop.txt` is the real output of the list, `keep`, the one-session view, the closeout dry run, `--apply` and the list again, on a made-up laptop with five sessions. The apply pushed one branch, deleted one merged local branch (printing its tip so it can be recreated) and saved one set of floating commits under `rescue/`. It left the two tickets to the agent and the open pull request to Josh.

## What still needs the laptop

Nothing needs Josh. After the merge, the laptop picks the change up through `main` (JP-105); then on the laptop:

1. `python3 ~/.josh-360/repo/ledger/loose_ends.py --fetch` gives the live list from the real ledger. It will be long at first (the laptop inventory counted about 1,000 before the ledger existed); `--limit`, `--kind` and `--json` narrow it.
2. `/closeout` in a Claude Code session calls the agent. Its first run is Josh's to watch: the `by: josh` items are the ones it will ask about.
