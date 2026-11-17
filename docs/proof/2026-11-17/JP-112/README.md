# JP-112 proof: record friction facts from every session, with no model

## Contents

- [Scenarios](#scenarios)
- [What the rows look like](#what-the-rows-look-like)
- [What still needs the laptop](#what-still-needs-the-laptop)
- [What this ticket did not build](#what-this-ticket-did-not-build)

## Scenarios

Every transcript, folder, ticket, command and pull request here is made up, built in a temporary home by `tests/test_ledger_friction.py` and `tests/test_ledger_measures.py` (with `tests/ledger_transcripts.py`). No real transcript is read.

| Scenario | Proof | Test |
| --- | --- | --- |
| Counts, not text | `01-rows-and-headline.txt` (the rows, their columns, and a search of the whole ledger for the made-up message, command and file text: none) | `Wired.test_no_message_command_or_file_text_reaches_the_ledger`, `Reader.test_every_count`, `Reader.test_names_that_are_not_plain_identifiers_are_dropped` |
| No model is involved | `02-friction-tests.txt` | `Wired.test_no_model_and_no_network` (the recorder runs with sockets refused), `Wired.test_the_modules_import_nothing_that_can_reach_a_model` |
| The headline can be read | `01-rows-and-headline.txt` (the command's output on a made-up ledger) and `03-measures-tests.txt` | `Headline.test_messages_per_finished_ticket_beside_the_first_time_share`, `FirstTime.test_signed_off_without_being_sent_back`, `Headline.test_live_status_comes_from_jira_and_an_unreadable_ticket_is_unknown` |
| Working agents cannot see the measures | `02-friction-tests.txt`, `04-ask-tests.txt` | `AgentsCannotSeeTheMeasures.test_ask_never_names_a_friction_table_or_a_measure`, `AgentsCannotSeeTheMeasures.test_no_answer_from_ask_holds_a_friction_value_or_a_usage_name`, and the existing `Ask.test_no_query_returns_friction_cost_or_measures` |
| The suite still passes | `05-suite.txt` | `python3 scripts/check.py`, which runs all 290 `test_ledger_*` tests and the rest |

Also tested: a session started by a script records none of Josh's messages (`Wired.test_a_script_session_records_no_message_of_josh`), a failure writing friction never stops the episode (`Wired.test_a_failure_writing_friction_never_stops_the_episode`), a code not in `ledger/codes.json` is refused (`Writer.test_a_code_that_is_not_listed_is_refused_and_nothing_is_written`), and episodes recorded before this merged get their facts once, and only once (`CatchUp`).

## What the rows look like

`01-rows-and-headline.txt` shows one made-up session's `session_facts` and `session_usage` rows. Facts are a code from `ledger/codes.json` and a number; usage rows are a kind (skill, agent, tool, MCP server), a plain identifier, a loaded flag and a use count. The choices behind the definitions (who counts as Josh, what is an answer, the waiting and working caps, the context window, finished, first time) are rows in `docs/decisions.md`, each with how to change it.

## What still needs the laptop

Nothing needs Josh. After the merge reaches the laptop (JP-105):

1. The `ledger-record` job writes friction facts with each new episode.
2. The one-time `ledger-friction-catchup` job fills in episodes recorded before. Check with `python3 laptop/status.py show`: `reports/ledger-friction-catchup.json` should appear with `episodes` above zero, and a small `no_transcript` count (sessions whose transcript has been cleaned up).
3. If the report is missing after an hour, read `logs/ledger-friction-catchup.log` on the `laptop-status` branch and fix forward.
4. Two weeks of real rows should settle the final code lists in `ledger/codes.json` and whether the "loaded" lists in real transcripts have the shape the reader expects (`docs/decisions.md`, "Which loaded items get a usage row?").

## What this ticket did not build

- The loose-ends measure: JP-109 computes loose ends. `python3 ledger/measures.py loose-ends` says so.
- The debrief form (JP-113), any report, and anything that shows these numbers to working agents (all out of scope in the ticket).
