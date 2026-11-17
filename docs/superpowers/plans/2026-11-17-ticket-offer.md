# JP-110 Ticket offer plan

## Contents

- [Why this plan is short](#why-this-plan-is-short)
- [Reading of the ticket](#reading-of-the-ticket)
- [Design choices](#design-choices)
- [Tasks](#tasks)
- [Proof](#proof)
- [Out of scope](#out-of-scope)

## Why this plan is short

JP-110 was `Not Started` when the build began, not `Ready`: no separate agent had signed it off. Josh ruled on 17 November 2026 that for this project everything in epic JP-94 is fair game once no ticket blocks it, and the only blocker (JP-107, the ledger) is Done. The ticket already carries its scenarios, so this plan only fixes the choices the ticket leaves open. It is recorded in `docs/decisions.md` too.

## Reading of the ticket

When a session is about to make its first commit, or create its first branch, and nothing ties it to a ticket, the session says one line to Josh and carries on. It never blocks and never asks twice. The offer and Josh's answer go into the ledger table `ticket_offers` (already in the schema), and a "yes" also writes a `ticket_links` row with source `offer`.

## Design choices

1. **The hook is a `PreToolUse` hook on Bash** in `hooks/PreToolUse/30-ticket-offer`. It reads the command and recognises `git commit`, `git checkout -b`, `git switch -c`, `git branch <name>` and `git worktree add -b`. Anything else exits at once, because `PreToolUse` runs on every tool call.
2. **It never blocks.** It exits 0. When it offers, it prints `hookSpecificOutput.additionalContext` telling the agent to say the one line and carry on. Plain output from `PreToolUse` does not reach the agent, and exit 2 would block, so JSON context is the only route.
3. **Once per session** is a marker file, `~/.josh-360/state/ticket-offer/<session id>`, created with `O_EXCL`, so two hooks firing together still offer once. The marker also holds the answer.
4. **"Already ticketed" is decided from cheap local facts, with no model:** the current branch or the new branch name starts with a ticket key (the same pattern the recorder uses), the session was started by the walker, the daemon or the desk (`ledger/spool.started_by`), or the ledger already holds a ticket link for the session. The ledger is opened read-only, best effort: a failed read means "no link known".
5. **The answer is spooled by a script, never written by the agent into the database.** The hook tells the agent the exact command to run: `ledger/offer.py --session <id> accepted <KEY>` or `declined`. The command refuses unless the session has an open offer, and appends one line to the spool.
6. **The recorder writes the rows.** `ledger/record.py` reads `TicketOffer` spool lines and writes `ticket_offers` (and the `ticket_links` row on accept). The hook still never writes the database.
7. **No answer is a missing row.** The ledger holds `offered` with no `accepted` or `declined`, and nothing guesses.

## Tasks

1. `ledger/offer.py`: command recognition, the marker, the spool line, the hook body and the answer command. Tests first in `tests/test_ledger_offer.py`.
2. `hooks/PreToolUse/30-ticket-offer`: the thin executable, tested through `hooks/dispatch`.
3. `ledger/record.py`: read `TicketOffer` lines into `ticket_offers` and `ticket_links`. Tests in `tests/test_ledger_offer.py` and the one counts assertion in `tests/test_ledger_record.py`.
4. Docs: `ledger/README.md`, `hooks/README.md`, `docs/decisions.md`.
5. Full suite, proof under `docs/proof/2026-11-17/JP-110/`, PR, ceremony, merge.

## Proof

Each scenario of the ticket maps to a test in `tests/test_ledger_offer.py`. They are listed in the proof page. The one thing no cloud test can show is a real Claude Code session on the laptop passing `additionalContext` to the agent; the proof page names it as the laptop check after merge.

## Out of scope

Blocking or delaying the commit, asking twice, question-only sessions, and the ticket creation graph itself (JP-121). Until that graph exists the agent uses Josh's `using-jira` flow.
