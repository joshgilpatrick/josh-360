# JP-121 laptop check: one made-up to-do through the ticket creation graph

## Contents

- [Result](#result)
- [What was run](#what-was-run)
- [Each step](#each-step)
- [What Jira showed](#what-jira-showed)
- [What surprised me](#what-surprised-me)
- [Next steps](#next-steps)

Plan: `docs/superpowers/plans/2026-11-16-ticket-creation-graph.md`, Task 9 step 5. Run on Josh's laptop on 17 November 2026. Every text in this check is made up. No patient data was used or written anywhere.

## Result

The graph took one made-up to-do to one correct ticket, **JP-154**, after Josh approved the card. Every Jira check passed, and JP-154 is now Cancelled. One thing failed: the walker crashed while closing the run out (see [What surprised me](#what-surprised-me)). The ticket was already written by then.

## What was run

- Main was current and included merge 5ea64d5.
- A throwaway `action-items.json` in a temporary folder held one to-do: id `e2e-todo-1`, status `active`, text "Add a --version flag to the made-up e2e tool". `JOSH360_ACTION_ITEMS` pointed at it, so Josh's real list was never read or changed.
- The Jira email was not set anywhere, so `JOSH360_JIRA_EMAIL` was set to the git email for each command. The token came from the keychain item `jira-claude-api-key`.
- Run id: `r-24a77578551b`, started with `python3 graphs/intake/submit.py --source todo --ref e2e-todo-1`. No runner job exists, so one session acted as each role.

## Each step

| Step | Result |
| --- | --- |
| Flag script, `set-flag.py --ticket JP-121 --on` then `--off` | Both exited 0 |
| `read_intake` (intake-reader) | `recorded`: a Task, code, light, repository unresolved |
| `route` (gate) | `unmatched`, rule `fallback`: space JP, no parent |
| `find_duplicates` (jira-searcher) | `searched`: no candidates |
| `duplicate_rule` (gate) | `new_light` |
| `draft` (ticket-drafter), attempt 1 | `drafted`, with one gap: which repository and parent? |
| `check_draft` (gate), attempt 1 | `fixable`: "t1: Repository is empty" |
| Question to Josh | Josh chose repository josh-360 and parent JP-94 |
| `draft`, attempt 2 | `drafted`, changing only the repository, parent, labels and the gap |
| `check_draft`, attempt 2 | `pass`; the card was built |
| `approve` | Parked, then answered `approve` by Josh |
| `write` (gate) | `created`: JP-154 |
| `link_source` (gate) | `linked` |
| `_exit` (gate) | `pass` |

The approval card read: "New ticket from a to-do: Add a --version flag to the made-up e2e tool. Create in JP under JP-94 (josh-360, as you named it; area: Automation and AI enablement). Task, code, light, runs in a cloud session (inferred). 1 scenario. Duplicates: none."

## What Jira showed

Read back after the run, before cancelling:

| Check | Expected | Found |
| --- | --- | --- |
| New tickets | one | one: JP-154 |
| Space and status | JP, Not Started | JP, Not Started |
| Parent | set | JP-94 |
| Priority | none | none |
| Assignee | none | none |
| Agent Status | none | no custom field was set |
| Labels | `josh-360` | `josh-360` |
| Property `action-triage.spec` | `{"type": "code"}` | `{"type": "code"}` |
| Property `josh360.authors` | the session ids | one session id |
| Comments and links | none | none |
| The temp to-do | carries the key | `ticketKey: JP-154`, status `tasked` |

JP-154 was then moved to **Cancelled** with the repository's Jira library (`Jira.transition`); its status read back as Cancelled. No other ticket was touched, and JP-121 itself only had its flag turned on and off.

## What surprised me

1. **The walker crashed while closing the run, after the ticket was written.** `walker.py next` raised `OSError: File name too long` in `graphs/tools/walker_lib/runfolder.py`, in `files_to_save` (line 104). It checks every string output with `Path(value).is_file()`, and one output is the card, which is several lines long. A card is not a path, so the check fails on it. Retrying gives the same crash. As a result the run's end is not written to the ledger (`run_end` is empty), although the run state says `finished` and the flag is off. The fake-Jira tests did not catch it.
2. **The Needs you tab did not deliver Josh's approval.** The run stayed parked at `approve` until I recorded the answer with `walker.py answer --choice approve`, at Josh's request. I have not found out why the tab did not send it.
3. **The to-do names no repository**, so routing fell back to JP with no parent and the first draft was stopped by the check. That is the graph working as designed, and it needed one answer from Josh. The proposal's `route.rule` says `named` while the walker's route step says `fallback`; the card used the proposal's words.
4. **My duplicate search was by hand.** I searched JP, AD and CI for several words (version flag, print version, e2e) and found nothing, but the card lists the intake record's search terms rather than the exact queries I ran.
5. **No Jira email was configured**, and the keychain account name is `jgilpatrick`, not an email. The walker finds the token by service name, so only `JOSH360_JIRA_EMAIL` is missing.

## Next steps

- Fix the crash: in `files_to_save`, skip a value that contains a newline or is longer than a path can be, or catch `OSError`, and add a test that ends a run whose output is a multi-line card. Then re-run `walker.py next --run r-24a77578551b` to write the run's end to the ledger. I did not change the walker, because it belongs to JP-114.
- Find out why the Needs you tab answer did not reach the walker.
- Set `JOSH360_JIRA_EMAIL` once in the shell profile so the walker does not need it per command.
