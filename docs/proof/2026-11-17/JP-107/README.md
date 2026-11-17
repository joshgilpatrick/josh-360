# JP-107 proof: build the ledger and record facts from every session

## Contents

- [Scenarios](#scenarios)
- [What still needs the laptop](#what-still-needs-the-laptop)

## Scenarios

Every transcript, spool entry and folder in these tests is made up, built in a temporary home by `tests/ledger_transcripts.py`. No real transcript is read.

| Scenario | Proof | Test |
| --- | --- | --- |
| A session is recorded with nobody doing anything | `01-recorded-with-facts.txt` | `Recorder.test_quiet_session_is_recorded_with_its_facts` |
| An unknown folder stays honest | `02-unknown-folder-unassigned.txt` | `Recorder.test_an_unknown_folder_stays_honest` |
| No model is involved | `03-no-model.txt` | `Recorder.test_no_model_is_called` |
| Rows are never rewritten | `04-rows-never-rewritten.txt` | `Recorder.test_resume_adds_episode_2_and_keeps_episode_1` |
| A running session already has its row | `05-running-session-has-its-row.txt` | `Recorder.test_session_row_written_at_start` |
| A session keeps its words | `06-keeps-words.txt` | `Recorder.test_any_system_keeps_its_title` |
| Text that fails the screen is withheld | `07-screen-withholds.txt` | `Recorder.test_title_failing_the_screen_is_withheld` |
| A `.phi` folder keeps its words out | `08-phi-folder.txt` | `Recorder.test_phi_folder_stores_no_title`, `Recorder.test_phi_folder_stores_no_notes_or_cost_ledger_title`, `Notes.test_phi_folder_stores_no_notes` |
| The suite still passes | `09-suite.txt` | `python3 scripts/check.py` and all 234 `test_ledger_*` tests |

The tests are in `tests/test_ledger_record.py` and `tests/test_ledger_state_notes.py`. The other tests (`test_ledger_*.py`) cover the database, the spool, the transcript reader, homes, costs, the read command, backup, redaction and the backfill.

## What still needs the laptop

Scenario 9 of the ticket, "the laptop records real sessions", can only be seen after the merge. Nothing needs Josh.

1. Merging to `main` installs the change on the laptop (JP-105). The `ledger-record`, `ledger-backup` and `ledger-backfill` jobs start on their own.
2. Check with `python3 laptop/status.py show`. `reports/ledger-backfill.json` should appear with a `sessions` count above zero.
3. If the report is missing after an hour, read `logs/ledger-backfill.log` on the `laptop-status` branch and fix forward.
