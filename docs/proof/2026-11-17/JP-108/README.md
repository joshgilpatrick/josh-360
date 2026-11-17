# JP-108 proof: write five summary lines when a session goes quiet

## Contents

- [Scenarios](#scenarios)
- [What still needs the laptop](#what-still-needs-the-laptop)

## Scenarios

Every transcript, STATE.md and model answer in these tests is made up (`tests/test_ledger_summary.py`, using the recorder's helpers). The model is a fake that counts its calls; no network is used and no real transcript is read. `07-sample-summaries.txt` shows what a summary looks like.

| Scenario | Proof | Test |
| --- | --- | --- |
| Enough material means no model | `01-enough-material-no-model.txt` | `Summaries.test_enough_material_means_no_model`, `test_a_title_and_a_timeline_are_enough_without_a_first_line`, `test_a_question_only_session_is_described_by_its_first_line` |
| Thin material means one call, and its cost is recorded | `02-thin-material-one-call-cost-recorded.txt` | `Summaries.test_thin_material_means_one_call_and_its_cost_is_recorded` |
| A resumed session is summarised again | `03-resumed-session-summarised-again.txt` | `Summaries.test_a_resumed_session_is_summarised_again` |
| Nothing depends on a closeout step | `04-closed-terminal-still-summarised.txt` | `Summaries.test_a_closed_terminal_still_gets_its_summary` |
| About five lines, and a check that rejects more | `05-all-summary-tests.txt` | `test_more_than_five_lines_or_800_characters_is_rejected`, `test_the_worst_case_stays_inside_the_limit` |
| No patient data | `05-all-summary-tests.txt` | `test_a_first_line_that_fails_the_screen_is_withheld_and_counted`, `test_a_phi_folder_keeps_its_words_out_and_never_calls_a_model` |
| The suite still passes | `06-suite.txt` | `python3 scripts/check.py` |

`05-all-summary-tests.txt` is all 34 summary tests: the call's limits (at most three a run, one retry on the tier's next model, none for an old episode or a `.phi` folder), the fake `claude` that checks the real call has no tools, no saved session and the internal flag, and the guard that stops that call being recorded as a session.

## What still needs the laptop

The real `claude -p` call was run once in the cloud on a made-up one-line prompt to check the flags and the answer's shape: it returned its text, `claude-haiku-5-5`, 11,951 input and 238 output tokens and a cost of about $0.0024, which `claude_caller` turns into a `model_calls` row. What can only be seen after the merge is the call on real sessions. Nothing needs Josh.

1. Merging to `main` installs the change on the laptop (JP-105). The `ledger-summary` job starts on its own.
2. A few minutes later, read the ledger: `python3 ledger/ask.py find --folder <a folder you worked in> --since 2026-11-17` should show a `summary_line`. `~/.josh-360/logs/ledger-summary.log` says if `claude` was not found.
3. For a session that earned a call, `model_calls` has a `summary` row with its cost. If every call fails, the cause is the flags in `claude_caller` (`ledger/summary.py`); the lines are still written from the ledger's facts after two tries, so no session is left without one.
