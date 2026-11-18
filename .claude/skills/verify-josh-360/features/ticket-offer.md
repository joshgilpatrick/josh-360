# Ticket offer

When a session with no ticket is about to make its first commit or create its first branch, the agent is told to offer Josh a ticket in one line and carry on. It happens once per session, never blocks the command, and the offer (and later Josh's answer) is recorded in the ledger (JP-110).

## Sub-features

- `offer-first-commit` the first `git commit` in an unticketed session gets the offer as `additionalContext`.
- `offer-once` a second qualifying call in the same session gets nothing.
- `offer-ticketed-quiet` a session on a branch that starts with a ticket key gets no offer.
- `offer-recorded` the offer is a spool line, and the recorder writes a `ticket_offers` row.
- `offer-answer` `ledger/offer.py --session <id> accepted <KEY>` or `declined` records Josh's answer.

## How to get to it (user POV)

- In any Claude Code session on the laptop, on a branch with no ticket key, make the first commit (`git commit`) or create the first branch (`git checkout -b`, `git switch -c`, `git branch`).
- After Josh answers, the agent runs `python3 ~/.josh-360/repo/ledger/offer.py --session <id> accepted <KEY>` or `... declined`.

## Driving it with sandbox.py

Preconditions:

- A launched sandbox `<id>` whose `doctor` printed `"ok": true`.
- A seeded session with no ticket: `$S seed-session --run <id> --session verify-sess-0002 --branch sample-work --folder untracked-repo`.
- A hook input file for its first commit, `<run>/payloads/offer.json`: `{"session_id": "verify-sess-0002", "transcript_path": "<transcript from seed-session>", "cwd": "<run>/work/untracked-repo", "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "git commit -m 'sample change'"}}`.

- **First commit.** Fire the hook as Claude Code does before the Bash call. Run `$S hook --run <id> --event PreToolUse --payload <run>/payloads/offer.json --name offer-first`. Exit code `0`; stdout is JSON whose `hookSpecificOutput.additionalContext` starts `Josh 360 ticket offer (JP-110)` and names `graphs/intake/submit.py --source session --ref verify-sess-0002`.
- **Only once.** Fire the same input again. Run `$S hook --run <id> --event PreToolUse --payload <run>/payloads/offer.json --name offer-second`. Exit code `0` and empty stdout.
- **Spool line.** Run `$S run --run <id> --name offer-spool -- grep TicketOffer <run>/home/.josh-360/state/ledger-spool/<today>.jsonl`. One line with `"offer_event": "offered"`, `"offer_trigger": "first-commit"`, `"ticket_key": null`, and no command text.
- **Answer.** Record Josh's yes. Run `$S run --run <id> --name offer-answer -- python3 ledger/offer.py --session verify-sess-0002 accepted JP-9002`. Exit code `0`.
- **Recorded.** Fire the session's start hook first (`$S seed-session` wrote `<run>/payloads/verify-sess-0002-start.json`) with `$S hook --run <id> --event SessionStart --payload <run>/payloads/verify-sess-0002-start.json`, then run `$S run --run <id> --name offer-record -- python3 ledger/record.py`. Its counts include `"offers"` above 0. Then `$S ledger --run <id> --name offer-rows "SELECT offer_event, offer_trigger, ticket_key FROM ticket_offers"` shows the `offered` and `accepted` rows.
- **Ticketed is quiet.** Repeat the first-commit input with `cwd` set to a folder seeded on a `JP-9001-...` branch and a new session id. Exit code `0` and empty stdout.

## Gotchas

- The hook acts only on the Bash tool and only on a commit or branch-creating command; any other input is silently ignored, which looks the same as "already offered".
- The marker that makes it once-per-session lives under `~/.josh-360/state`; a new sandbox resets it, a re-run in the same sandbox does not.
- The recorder writes `ticket_offers` only for a session it knows, so fire that session's `SessionStart` hook before running `ledger/record.py`.
- The offer text's branch advice says `<KEY>/<slug>`; josh-360's own rule is `JP-<n>-<slug>`, and every script reads both.
- A graph step's session (one linked by the `20-graph-step` hook) never gets an offer.
