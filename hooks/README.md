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
| `PreToolUse/30-ticket-offer` | PreToolUse | At a session's first commit or first new branch with no ticket linked, tells the agent to offer a ticket in one line. Once per session; never blocks. It prints JSON (`additionalContext`) only when it offers, so any later `PreToolUse` hook that also prints JSON would be ignored for that call. | JP-110 |

## Rules for a hook

- It reads the event's JSON on stdin, as Claude Code sends it.
- Exit 0 to carry on, exit 2 to block (its stderr goes to Claude). Any other exit is logged in `~/.josh-360/logs/hooks.log` and skipped, so a broken hook never stops a session.
- Only one hook per event should print JSON. If several do, the first wins and the others are logged.
- Keep it fast: `PreToolUse` and `PostToolUse` run on every tool call.
- Use the laptop's `/usr/bin/python3` (3.9) and the standard library, or bash 3.2.
- No patient data in anything it writes or logs.
