# Hooks

Claude Code hooks that Josh 360 adds to every session on the laptop (JP-105).

## Contents

- [How they load](#how-they-load)
- [Adding a hook](#adding-a-hook)
- [Hooks in this folder](#hooks-in-this-folder)
- [Rules for a hook](#rules-for-a-hook)

## How they load

The claude-harness settings register one command per hook event, and each one calls `hooks/dispatch <Event>` in the laptop's copy of this repo (`~/.josh-360/repo`). The dispatcher runs every executable file in `hooks/<Event>/`. A new hook is a new file here, merged like any change; the harness never changes again.

Known events: `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification`, `Stop`, `SubagentStop`, `PreCompact`, `PostCompact`. The install script stops if `hooks/` holds a folder with any other name.

## Adding a hook

1. Put an executable file in `hooks/<Event>/`, named with a number first so the order is clear, for example `hooks/SessionEnd/10-record-facts.py`.
2. Give it a test under `tests/`.
3. Merge. The laptop runs it from its next follow pass (within 10 minutes).

## Hooks in this folder

| File | Event | What it does | Ticket |
| --- | --- | --- | --- |
| `SessionStart/20-ledger-spool`, `SessionEnd/20-ledger-spool` | SessionStart, SessionEnd | Append one line to the ledger spool. | JP-107 |
| `PreToolUse/10-atlas-removal-guard` | PreToolUse | For the Bash tool only, runs Session Atlas's worktree removal guard (`apps/session-atlas/hooks/atlas-removal-guard.js`): `git worktree remove` of a linked worktree is allowed only when Atlas's removal check says nothing is at risk. It exits 2 to block and fails closed. It prints nothing when it allows. | JP-111 |
| `PostToolUse/40-jira-session-link` | PostToolUse | When a `jira workitem` transition or comment names an issue key, records the link in the cost tables of `cache.db`. Prints nothing; always exits 0. | JP-111 |
| `PreToolUse/30-ticket-offer` | PreToolUse | At a session's first commit or first new branch with no ticket linked, tells the agent to offer a ticket in one line. Once per session; never blocks. It prints JSON (`additionalContext`) only when it offers, so any later `PreToolUse` hook that also prints JSON would be ignored for that call. | JP-110 |
| `PostToolUse/40-ticket-comments`, `UserPromptSubmit/40-ticket-comments` | PostToolUse, UserPromptSubmit | Print the session's waiting ticket comments as `additionalContext` (labelled as information, not an instruction) and mark them read. They read only the session's own inbox folder, never open the ledger, and print nothing when there is none. `PostToolUse` reaches a session between tool calls, `UserPromptSubmit` one that is waiting for Josh. | JP-118 |
| `UserPromptSubmit/20-graph-step` | UserPromptSubmit | When a session's first prompt carries the graph runner's marker line (`[josh360-step run=... step=... attempt=... key=...]`) for a step the runner has just started, links the session to its run and step: it writes a link file in the run's `sessions/` folder and an entry in `~/.josh-360/state/graph-sessions/`, which the other three graph-step hooks read. Prints nothing; acts only when the marker's key matches an unlinked session file, so a session that merely quotes a marker line is untouched. | JP-117 |
| `PreToolUse/20-graph-step-guard` | PreToolUse | The rails for a graph step's session: denies (exit 2, with a message the session reads) a call past the turn cap or time cap, a question to Josh, a Jira or GitHub write, a read of secrets or the keychain, a change to the runner, the ledger, the settings or another run, and, for a read-only step, a change outside the work folder. A session with no graph-session entry is untouched. The Bash rules read the command text: they narrow the obvious paths and are not a boundary (a shell can still reach a path by expansion). | JP-117 |
| `PostToolUse/20-graph-step-reflect` | PostToolUse | Every 40 tool calls of a graph step's session, once, adds "are you looping?" as `additionalContext`. Never blocks; prints nothing for other sessions. | JP-117 |
| `Stop/20-graph-step-stop` | Stop | When a graph step's session stops: passes on the ticket comments waiting in the run's `comments/` folder (labelled as information, not an instruction), or, if the step has no result file yet, tells the session once where to write it and which outcomes it may use. Never blocks twice in a row; prints nothing for other sessions. The ledger's comment and offer hooks stay quiet in a graph session. | JP-117 |

## Rules for a hook

- It reads the event's JSON on stdin, as Claude Code sends it.
- Exit 0 to carry on, exit 2 to block (its stderr goes to Claude). Any other exit is logged in `~/.josh-360/logs/hooks.log` and skipped, so a broken hook never stops a session.
- Only one hook per event should print JSON. If several do, the first wins and the others are logged.
- Keep it fast: `PreToolUse` and `PostToolUse` run on every tool call.
- Use the laptop's `/usr/bin/python3` (3.9) and the standard library, or bash 3.2.
- No patient data in anything it writes or logs.
