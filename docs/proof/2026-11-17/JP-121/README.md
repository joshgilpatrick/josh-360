# JP-121 proof: build the ticket creation graph

## Contents

- [Part 1: the shared Jira library](#part-1-the-shared-jira-library)
- [Part 2: the graph](#part-2-the-graph)
- [What still needs the laptop](#what-still-needs-the-laptop)

## Part 1: the shared Jira library

JP-121 lands the Jira library every graph build shares (`graphs/gates/lib/jira.py`, `adf.py`) first, in its own pull request, so JP-122 and JP-123 can use it. The two effect scripts the walker calls, `set-flag.py` and `post-comment.py`, stop being stubs. Every Jira answer in these tests is a made-up stand-in.

| Scenario | Proof | Test |
| --- | --- | --- |
| A create reports a key only when Jira confirms; an unconfirmed create is `None`, a refusal raises | `01-jira-library.txt` | `Creating` (7 tests) |
| Reads answer `None` when unknown; ticket text and comments come back as plain text | `01-jira-library.txt` | `Reading` (5 tests) |
| Comments, moves, flags, links and properties are confirmed by a read-back | `01-jira-library.txt` | `Writing` (7 tests) |
| Patient identifiers are stopped before any request, naming the kind and never the text | `01-jira-library.txt` | `test_patient_data_in_a_summary_is_refused_before_any_request`, `test_comment_with_a_patient_identifier_is_refused_and_not_sent`, `test_post_comment_stops_at_a_patient_identifier` |
| The flag and the comment scripts exit 0 only when Jira confirms | `01-jira-library.txt` | `TheTwoEffectScripts` (4 tests) |
| The whole suite passes | `02-suite-library.txt` | `python3 scripts/check.py` |

## Part 2: the graph

The seven gates, the submit command and the walker's `so_far` field, tested one by one and then walked as a whole graph with the real walker and the real gate scripts. Jira is a folder-backed stand-in that records every request. Every text and key is made up.

| Scenario | Proof | Test |
| --- | --- | --- |
| A light request becomes one ticket, linked back to the item | `04-full-run.txt`, `05-ledger-rows-of-one-run.txt` | `test_light_todo_to_one_ticket` |
| Nothing is written before approval | `04-full-run.txt` | `test_nothing_is_written_before_approval` |
| An open duplicate gets one comment and no ticket | `04-full-run.txt` | `test_an_open_duplicate_gets_a_comment_and_no_ticket` |
| A Done duplicate gets a new ticket linked to it | `04-full-run.txt` | `test_a_finished_duplicate_gets_a_new_ticket_linked_to_it` |
| No rule gives a home, so Josh is asked and nothing is written | `04-full-run.txt` | `test_when_no_rule_gives_a_home_josh_is_asked_and_nothing_is_written` |
| The same item is not filed twice; request text never starts a run | `04-full-run.txt` | `test_the_same_item_is_not_filed_twice`, `test_a_pointer_that_is_text_never_starts_a_run` |
| Tickets stay in Not Started, with no priority, assignee or Agent Status; authors recorded | `04-full-run.txt` | `test_the_created_ticket_is_not_ready_and_carries_its_authors` |
| The draft runs three times, then asks Josh | `04-full-run.txt` | `test_draft_runs_are_capped_at_three_and_the_fourth_goes_to_stuck` |
| An unconfirmed create is found, never made twice; a partial result is finished without repeats | `03-gates.txt` | `test_gate_create_tickets` (15 tests) |
| Gates: entry, route, duplicate rule, completeness, patient data, card text, link, close | `03-gates.txt` | 78 tests |

## What still needs the laptop

The library has only been run against a stand-in. One live check on the laptop, which the later parts of JP-121 do on their own end-to-end run: `set-flag.py --ticket JP-121 --on` then `--off` (the flag field id `customfield_10021` is the one action-triage reads).


Part 2 adds the end-to-end run named in plan Task 9, step 5: after merge, run one made-up to-do through `python3 graphs/intake/submit.py --source todo --ref <id>` against the JP space, approve the card in the Needs you tab, confirm the ticket in Jira, then cancel it. Record the key and the cancel here.
