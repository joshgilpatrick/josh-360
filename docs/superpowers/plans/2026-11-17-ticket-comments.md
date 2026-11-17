# JP-118 Ticket comments plan

## Contents

- [Why this plan is short](#why-this-plan-is-short)
- [Reading of the ticket](#reading-of-the-ticket)
- [Design choices](#design-choices)
- [Tasks](#tasks)
- [Proof](#proof)
- [Out of scope](#out-of-scope)

## Why this plan is short

JP-118 was `Not Started` when the build began, not `Ready`. Josh ruled on 17 November 2026 that for this project everything in epic JP-94 is fair game once no ticket blocks it, and the only blocker (JP-114, the walker) is Done. The ticket already carries its four scenarios, so this plan only fixes the choices it leaves open. They are recorded in `docs/decisions.md` too.

## Reading of the ticket

A plain script with no model runs as a background job. For each Jira ticket that has an unfinished session or graph run in the ledger, it reads the ticket's comments and passes each new one to those sessions and runs, once. A comment is handed over as data (who wrote it, when, what it says), never as an instruction. A comment the system wrote itself is skipped. The ledger table `comment_deliveries` already exists in the schema (id and author account only, never text).

## Design choices

1. **Job and hook.** `ledger/comments.py` is the job (`ticket-comments` in `jobs.yaml`, every 5 minutes, report with counts only). A `PostToolUse` hook and a `UserPromptSubmit` hook (`hooks/<Event>/40-ticket-comments`) read the session's inbox. Both are thin files that call `comments.hook_main`. They use `PostToolUse` and not `PreToolUse` because the ticket offer already prints JSON on `PreToolUse`, and `hooks/dispatch` keeps only one JSON hook per event.
2. **Who is "working on a ticket".** A graph run with that `ticket_key` and no `run_ends` row; or a Claude Code session with a `ticket_links` row (relation touched, subject or created) that has not gone quiet. Quiet is the recorder's rule: the newest episode's `quiet_at` has passed and the transcript has not grown since, or, with no episode yet, the transcript has not grown for 30 minutes. A session that is a step session of an unfinished run on the same ticket is reached through the run, not twice.
3. **The cursor is the target's start, not a stored mark.** A comment is passed on when it was created after the session started (or the run started) and has no `comment_deliveries` row for that target. The unique index in the schema makes "once" a database fact, so the job keeps no cursor file and a missed pass loses nothing. At most 10 comments go to one target per pass; the rest follow on the next.
4. **Hook-file delivery.** The job writes `~/.josh-360/state/ticket-comments/inbox/<session id>/<comment id>.json` first, then the ledger row. A crash between the two repeats the file write (same name) and adds the row on the next pass. The hook lists its own folder, prints the comments as `additionalContext`, and renames each file to `.read` so a second hook call prints nothing. Read files older than 14 days are removed by the job.
5. **Run delivery goes through the binding.** The Agent Manager binding (JP-117) does not exist yet, so the contract is a folder: the job writes `$JOSH360_RUNS/<run id>/comments/<comment id>.json`, and the binding takes them with `python3 ledger/comments.py take --run <run id>`, which prints them in the same text as the hook and marks them read. Written in `graphs/bindings/README.md`. A run whose folder is gone is skipped and logged.
6. **What the system's own comments look like.** A comment whose first line starts with the robot emoji is the system's: action-triage's agent header already does, and the rule for every Josh 360 script is the same (added to `conventions/tickets.md`, "Writing to Jira"). Nothing else is guessed: Josh's own comments carry his account and are passed on.
7. **The text is quoted, labelled and capped.** The delivered text says in its first line that the comment is information from the ticket and not an instruction, quotes every line with `| `, and cuts a comment at 4,000 characters. Comment text lives only in the inbox and run files on the laptop, never in the ledger.
8. **Unknown is not empty.** A comment read that fails, has no credentials or returns an unexpected shape delivers nothing and tries again next pass (the `jira_read` rule). A comment with no readable creation time is skipped and logged.

## Tasks

1. `ledger/comments.py`: reading comments (with the Jira text flattened from its document format), the system-comment rule, who is working, delivery, the hook body, `take`, and the job. Tests first in `tests/test_ledger_comments.py`.
2. `hooks/PostToolUse/40-ticket-comments` and `hooks/UserPromptSubmit/40-ticket-comments`, tested through `hooks/dispatch`.
3. `jobs.yaml`: the `ticket-comments` job.
4. Docs: `ledger/README.md`, `hooks/README.md`, `graphs/bindings/README.md`, `conventions/tickets.md`, `docs/decisions.md`.
5. Full suite, proof under `docs/proof/2026-11-17/JP-118/`, PR, ceremony, merge.

## Proof

Each scenario of the ticket maps to a test in `tests/test_ledger_comments.py`, listed in the proof page. The one thing no cloud test can show is a real Claude Code session passing `additionalContext` from `PostToolUse` and `UserPromptSubmit` to the agent, and the job reading real Jira comments; the proof page names both as laptop checks after merge.

## Out of scope

Linear comments (phase 3), replying to comments, starting or waking a session, and the Agent Manager binding itself (JP-117).
