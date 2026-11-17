# JP-118 proof: new ticket comments reach the sessions working on the ticket

## Contents

- [Scenarios](#scenarios)
- [What still needs the laptop](#what-still-needs-the-laptop)

## Scenarios

Every session, run, ticket, account and comment in these tests is made up, in a temporary home. Jira is a function returning canned JSON and the transcript clock is a function, so no network and no model is used. The hooks are run as Claude Code runs them: a process that reads the event's JSON on stdin, on its own and through `hooks/dispatch`.

| Scenario | Proof | Test |
| --- | --- | --- |
| A comment reaches the session | `02-end-to-end-demo.txt` | `TheScenarios.test_a_comment_reaches_the_session`, `TheHooks.test_the_session_is_told_on_both_events`, `TheHooks.test_it_runs_under_dispatch`, `Delivering.test_a_run_gets_the_comment_through_its_folder`, `TakingForARun` |
| A comment is delivered once | `02-end-to-end-demo.txt` (second job pass, second hook call) | `TheScenarios.test_a_comment_is_delivered_once`, `TheHooks.test_it_is_told_once`, `TheHooks.test_two_hooks_firing_together_print_it_once`, `Delivering.test_a_file_without_its_row_is_repaired_not_doubled` |
| No session, nothing sent | `01-tests.txt` | `TheScenarios.test_no_session_nothing_sent` (no ticket is even read), `Working.test_a_session_that_went_quiet_is_not_working`, `Working.test_a_run_with_no_end_is_working_and_an_ended_run_is_not` |
| The system's own comments are not echoed | `02-end-to-end-demo.txt` (`system: 1`, one comment delivered) | `TheScenarios.test_the_systems_own_comment_is_not_passed_back`, `Reading.test_the_systems_own_comments` |
| A comment is passed on as data | `01-tests.txt` | `Formatting`, `Delivering.test_no_comment_text_is_in_the_ledger`, `Delivering.test_a_long_comment_is_cut` |
| The suite still passes | `03-suite.txt` | `python3 scripts/check.py` |

The tests are in `tests/test_ledger_comments.py`. `02-end-to-end-demo.txt` runs the real job against a made-up ledger and the real `PostToolUse` hook through `hooks/dispatch`: the job's counts-only report, the ledger row (id and author account, no text), the JSON the agent receives, and the empty second call.

## What still needs the laptop

Nothing in the cloud can show a real Claude Code session receiving `additionalContext` from `PostToolUse` or `UserPromptSubmit`, or the job reading real Jira comments with the keychain token. These are `@manual`, after the merge, and need nothing from Josh beyond using a session as usual.

1. Merging to `main` installs the hooks and the `ticket-comments` job on the laptop within about 10 minutes (JP-105). Check with `python3 laptop/status.py show`; the job's report lands as `reports/ticket-comments.json` (counts only; `status` is `ok`, `no-jira-credentials` or `no-ledger`).
2. Start a Claude Code session on a branch named after a made-up test ticket, then add a comment to that ticket in Jira. Within about 10 minutes (5 for the job, plus the recorder's lag for the ticket link), the session's next tool call, or its next prompt, should include the comment under the line "Josh 360: new comment(s) on a ticket you are working on".
3. A read-only `sqlite3 ~/.josh-360/state/ledger.db "select ticket_key, comment_id, via from comment_deliveries"` shows one row per delivery.
4. If nothing arrives, read `~/.josh-360/logs/hooks.log` for `ticket-comments` lines. If the Claude Code version ignores `additionalContext` on `PostToolUse`, the decision row of 17 November says what to try instead.
