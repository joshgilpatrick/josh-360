# JP-175 proof: follow-ups from graph steps, and telling the lead

## Contents

- [What changed](#what-changed)
- [Scenarios](#scenarios)
- [The sandbox run](#the-sandbox-run)
- [Not proven here](#not-proven-here)

## What changed

A role step that finds work outside its ticket now writes it in its result as `follow_ups` (`graphs/contracts/follow-up.md`). The walker saves each one in the run folder and runs two fixed gates: `file-follow-ups` starts a ticket-creation run for it through intake, and `follow-up-wait` holds the run while a follow-up that blocks the ticket is open. `create-tickets` adds the label `graph-follow-up` and, for a blocking one, links the new ticket as blocking the old one. The runner tells the sprint lead or the epic lead, by script, when a run stops, parks a question, files or drops a follow-up, or finishes (`graphs/runner/runner_lib/leads.py`). Choices: `docs/decisions/JP-175.md`.

Every input is made up: the sandbox laptop of the verify-josh-360 skill, a folder-backed stand-in Jira, the stand-in `agent-manager` in `tests/fakes/`, a stand-in `sprint.py` and a temporary sprint-state folder. Nothing reaches Jira, Agent Manager or a model.

## Scenarios

The tests are `tests/test_follow_ups.py` (12 tests). They ran inside the sandbox copy of the committed branch: `verify-josh-360/follow-ups-tests.json`, exit code 0, `Ran 12 tests ... OK`.

| Scenario in the ticket | Proof |
| --- | --- |
| A non-blocking follow-up is filed through intake with the label `graph-follow-up`, the sprint lead gets one message naming JP-900 and the new key, and the run moves on | `test_it_is_filed_through_intake_the_lead_hears_and_the_run_moves_on`: the stand-in `sprint.py` logs one handoff for the new key whose note names JP-900; the new ticket carries the label; JP-900's run goes to its next step |
| A blocking follow-up makes the new ticket block JP-900, and the run is parked waiting on the new key | `test_the_new_ticket_blocks_the_origin_and_the_run_waits_on_it`: the stand-in Jira holds a Blocks link from the new key to JP-900; `runner.py status` shows the run `waiting` on the new key; it moves on once that ticket is Done. Also `test_a_dropped_follow_up_lets_the_run_go_on_and_says_so` and `test_a_comment_on_an_open_match_still_gets_the_blocks_link` |
| When the epic has a running epic lead, the epic lead is told and the sprint lead is not | `test_the_epic_lead_gets_the_message_and_the_sprint_lead_does_not`; and the fallback, `test_with_no_running_epic_lead_the_sprint_lead_is_told` |
| With no lead running, nothing is sent and the message is kept in the run folder | `test_nothing_is_sent_and_the_message_is_kept_for_the_next_lead`: no send, no handoff; `lead-messages.json` holds it unsent; `runner.py messages` lists it; it goes once a lead runs |
| No Agent Manager session is spawned to send messages | `test_filing_and_finishing_send_messages_and_spawn_nothing`: the stand-in `agent-manager` logs `send` calls and no `spawn` |
| The result shape | `test_a_bad_follow_up_is_refused_like_an_undeclared_output`, `test_no_follow_ups_changes_nothing`, `test_every_role_prompt_says_how_to_report_one`, `test_intake_sees_the_follow_up_file_as_the_item` |

## The sandbox run

Driven by hand with `sandbox.py` (feature file `graph-walker.md`, entry point `graphs/intake/submit.py --source session`). Each step is one JSON file in `verify-josh-360/`.

| Step | File | What it shows |
| --- | --- | --- |
| Start an intake run | `fu-submit.json` | exit 0, run `r-be6c276f0b6d` |
| First step | `fu-next-1.json` | the `read_intake` role step and its result file |
| Record a result with one follow-up | `fu-record.json` | `"recorded": true` and `"follow_ups": ["follow-up:r-be6c276f0b6d:read_intake-1-1"]` |
| The next pass files it and the run moves on | `fu-file-on-next.json` | the run ends at `route.personal` with no warning; the follow-up file is now `submitted` with intake run `r-8c69acd80317` |
| The new intake run reads the follow-up | `fu-intake-next.json` | its brief names the pointer `follow-up:r-be6c276f0b6d:read_intake-1-1`, never the words |
| It is driven by the graph runner | `fu-ledger-runner.json` | the ledger row of `r-8c69acd80317` has runner `agent-manager` |
| No lead to tell | `fu-messages.json` | `[]`: an intake run has no ticket, so it tells nobody |

## Not proven here

- Real Agent Manager `send` and the real `sprint.py handoff` against a live sprint lead [laptop]. To check: with a sprint running, let a graph step report a follow-up, then read `python3 ~/.josh-360/repo/graphs/runner/runner.py messages` (empty) and the lead's session for the `[sprint] new ticket` line.
- A real Jira Blocks link and the label on a real ticket [laptop]: the first real follow-up shows them; cancel it afterwards if it was a test.
- Josh still approves every follow-up on the ticket-creation card. That is by design (the ticket asks for intake), so a follow-up waits for him like any new ticket.
