# JP-110 proof: offer a ticket when a session's work becomes ticket-sized

## Contents

- [Scenarios](#scenarios)
- [What still needs the laptop](#what-still-needs-the-laptop)

## Scenarios

Every session id, folder, repository and ticket in these tests is made up, built in a temporary home. The hook is run as Claude Code runs it: a process that reads the event's JSON on stdin, both on its own and through `hooks/dispatch PreToolUse`.

| Scenario | Proof | Test |
| --- | --- | --- |
| First commit with no ticket: one line offered, the commit goes ahead whatever the answer | `01-first-commit.txt` | `TheOffer.test_first_commit_with_no_ticket_offers_one_line_and_goes_ahead`, `TheOffer.test_a_new_branch_with_no_ticket_key_offers_too`, `TheOffer.test_it_runs_under_dispatch`, `Recognising` |
| The offer is made once | `02-offer-made-once.txt` | `TheOffer.test_the_offer_is_made_once`, `TheOffer.test_two_hooks_firing_together_offer_once` |
| A ticket is already linked: no offer | `03-ticket-already-linked.txt` | `NoOffer.test_a_branch_named_after_a_ticket_key`, `NoOffer.test_creating_a_branch_named_after_a_ticket_key`, `NoOffer.test_sessions_started_with_a_ticket_have_one`, `WithTheLedger` |
| A question-only session: no offer | `04-question-only-session.txt` | `NoOffer.test_a_question_only_session_makes_no_offer` |
| The offer and the answer are recorded in the ledger (ticket scope) | `05-answer-recorded-in-ledger.txt` | `Answering`, `Recording` |
| The suite still passes | `06-suite.txt` | `python3 scripts/check.py` |

The `@auto` tests are in `tests/test_ledger_offer.py`. `01-first-commit.txt` also shows the hook's real output from a throwaway repository: the JSON the agent receives, exit code 0, the one spool line, and the silent second call.

## What still needs the laptop

Nothing in the cloud can show a real Claude Code session passing a `PreToolUse` hook's `additionalContext` to the agent. This is `@manual`, after the merge, and nothing needs Josh beyond using a session as usual.

1. Merging to `main` installs the hook on the laptop within about 10 minutes (JP-105). Check with `python3 laptop/status.py show`.
2. In a throwaway folder with no ticket, start a Claude Code session, ask it to create a file and make a commit. Its next message should include the one line, "This has become ticket-sized work, want me to open a ticket?", and the commit should still go ahead.
3. After the recorder's next pass (within 5 minutes), a read-only `sqlite3 ~/.josh-360/state/ledger.db "select event, offer_trigger, ticket_key from ticket_offers"` shows the `offered` row, and the answer once Josh gives one.
4. If the line never appears, read `~/.josh-360/logs/hooks.log` for `ticket-offer` lines, and fix forward. If the Claude Code version ignores `additionalContext` on `PreToolUse`, the decision row of 17 November says what to do instead.
