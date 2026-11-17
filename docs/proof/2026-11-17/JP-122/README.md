# JP-122 proof: build the triage and sign-off graph

## Contents

- [What was built](#what-was-built)
- [Each scenario and its proof](#each-scenario-and-its-proof)
- [What still needs the laptop](#what-still-needs-the-laptop)

## What was built

The triage graph (`graphs/flows/triage.yaml`) now runs for real: ten gate scripts in `graphs/gates/` (the entry gate `triageable`, `ticket-facts`, `ready-check`, `route`, `check-sign-off`, `triage-verdict`, `apply-revision`, `post-question`, `send-back` and `mark-ready`) and the shared `ready` entry gate for the development and non-development graphs. Their parts are in `graphs/gates/lib/triage/`. It reuses the Jira library from JP-121 and adds five calls to it. The design is `docs/superpowers/specs/2026-11-16-triage-graph-design.md`; its "As built" section lists the differences.

Every test runs the real gate scripts or the real walker against a folder-backed stand-in for Jira that records every request. Every ticket, key, session and text is made up; nothing real was read or written.

## Each scenario and its proof

| Scenario (spec, "Acceptance criteria") | Proof | Test |
| --- | --- | --- |
| A complete own ticket becomes Ready with one route, and the record holds no priority | `02-whole-run.txt` | `test_a_complete_own_ticket_becomes_ready_with_one_route`, `test_the_route_record_is_written_before_the_move`, `test_the_comment_on_ready_is_in_the_result_evidence_next_gate_shape` |
| The signing session is never an author | `02-whole-run.txt`, `03-gate-and-unit-tests.txt` | `test_the_signing_session_is_never_an_author`, `TheSignOffCheck` |
| An open question sends a Story back (C12) | `03-gate-and-unit-tests.txt` | `test_c12_an_open_question_a_marker_a_flag_and_an_unanswered_send_back` |
| A Research ticket keeps its open questions | `03-gate-and-unit-tests.txt` | `test_a_research_ticket_keeps_its_open_questions` |
| A defect that quotes nothing is dropped and recorded | `02-whole-run.txt`, `03-gate-and-unit-tests.txt` | `test_a_defect_that_quotes_nothing_is_dropped_and_recorded`, `TheSignOffFilter` |
| Two drafter rounds, then Josh asks through `ask_at_limit` | `02-whole-run.txt` | `test_two_drafter_rounds_then_josh`, `test_one_more_round_runs_the_drafter_once_more_and_then_asks_again` |
| Someone else's ticket gets a comment, not an edit, and Josh is not asked | `02-whole-run.txt` | `test_a_gap_gets_one_comment_and_no_edit_and_josh_is_not_asked` |
| Someone else's ticket edited mid-run reaches Josh only as a safety limit; the drafter never runs | `02-whole-run.txt` | `test_a_ticket_edited_mid_run_reaches_josh_only_as_a_limit_and_the_drafter_never_runs`, `test_a_ticket_changed_three_times_reaches_josh_as_a_limit_and_one_more_round_goes_back_to_read_ticket` |
| A ticket nobody queued is not admitted | `02-whole-run.txt`, `03-gate-and-unit-tests.txt` | `test_a_ticket_nobody_queued_is_not_admitted`, `TheEntryGate` |
| A code work kind with no repository is a conflict | `02-whole-run.txt`, `03-gate-and-unit-tests.txt` | `test_a_code_work_kind_with_no_repository_is_a_conflict_and_goes_back_to_the_drafter`, `test_a_work_kind_code_ticket_with_repository_none_is_a_conflict` |
| A ticket edited after sign-off is checked again and stays in Not Started | `03-gate-and-unit-tests.txt` | `test_mark_ready_moves_nothing_when_the_ticket_changed_after_sign_off`, `test_a_ticket_edited_after_sign_off_is_not_admitted_by_the_target_graph` |
| A designer question returns through triage and the ticket becomes Ready with `returned_from` set | `02-whole-run.txt` | `test_a_designer_question_returns_through_triage_and_the_drafter_writes_the_answer` |
| A third return goes to Josh, not the drafter | `02-whole-run.txt` | `test_a_third_return_goes_to_josh_and_the_drafter_is_not_started`, `test_josh_answering_resets_the_count_and_the_drafter_runs` |
| Triage's own edit does not start a run | `03-gate-and-unit-tests.txt` | `test_triages_own_comment_does_not_start_a_run`, `test_an_edit_after_triages_comment_starts_one` |
| Nested loops cannot reset each other's counters | `02-whole-run.txt` | `test_a_drafter_round_leaves_the_mark_ready_count_at_two` |
| The draft graph runs on a made-up ticket end to end (`@e2e`) | not run in the cloud | see below |
| The checker and the compiled copies agree | `01-graph-checker.txt` | `check_graph.py`, `compile_graphs.py --check` |
| The whole suite passes | `04-suite.txt` | `python3 scripts/check.py` |

Also proved, beyond the scenarios: a ticket the drafter cannot answer for goes to Josh with the one question posted on it first once (`test_a_drafter_who_cannot_answer_returns_one_question_and_josh_is_asked`, `test_post_question_posts_the_spec_copy_once`); a revision changing the type or aimed at someone else's ticket writes nothing (`test_a_drafter_cannot_change_the_type_or_edit_someone_elses_ticket`, `test_apply_revision_never_edits_someone_elses_ticket`); a move Jira does not confirm is a failure (`test_a_move_jira_does_not_confirm_is_a_failure`); every comment is held to the spec's own text (`TheCopyMatchesTheSpec`); a Ready ticket is admitted by the target graph, and only that one (`TheHandOffToTheTargetGraph`).

## What still needs the laptop

- The `@e2e` scenario: one run on two made-up JP tickets with the walker bound to Agent Manager, checking the ledger has one row per step with all nine fields.
- That a real sign-off session's id reaches the ledger through `record --session`; the tests record it by hand. If it does not, `check-sign-off` returns `invalid` and `mark-ready` refuses, so the failure is safe, not silent.
- `no-loose-ends`, the exit gate, is still JP-109's stub: a run that reaches its end stops there with the ticket already Ready. The tests assert this.
