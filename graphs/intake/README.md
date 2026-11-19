# Intake: starting a ticket-creation run

## Contents

- [The command](#the-command)
- [Sources and what a pointer is](#sources-and-what-a-pointer-is)
- [What happens next](#what-happens-next)
- [Who calls it](#who-calls-it)
- [Rules](#rules)

## The command

```
python3 graphs/intake/submit.py --source email|todo|session|manual --ref <pointer> [--space KEY] [--parent KEY]
```

It starts one `ticket-creation` run through the walker (`graphs/tools/walker.py start`) and prints the run id. It exits 2 with one line on stderr when the walker will not start a run: the entry gate `intake-admitted` refuses a second open run for the same item, a dismissed item, or a source that is not in the first wave.

`--space` and `--parent` are for a space or parent Josh named outright. They become the graph inputs `named_space` and `named_parent`, and the routing step honours them before it looks at the registry.

## Sources and what a pointer is

| Source | `--ref` is | Where the intake reader finds the item |
| --- | --- | --- |
| `email` | the desk's conversation id | the Email Research Desk's ledger (`DESK_DB`) |
| `todo` | the to-do or action item id | action-triage's `action-items.json` |
| `session` | the session id, or `follow-up:<run id>:<file id>` for work a graph step found outside its ticket (JP-175) | the ledger; for a follow-up, its file in the run folder (`graphs/contracts/follow-up.md`) |
| `manual` | an id or a path Josh gives | wherever that points |

A pointer is short and has no spaces. The command refuses text, so a request's own words, and anything in it that is patient data, never reach the walker, the run folder or the ledger through this door.

## What happens next

The graph reads the item, routes it by the registry, looks for a ticket that already covers it, drafts the ticket or a parent with children, checks the draft, shows Josh one card, and writes only after he approves. It writes the new ticket's key back to the item. Tickets stay in Not Started.

## Who calls it

- The JP-110 ticket offer, when Josh says yes (`--source session`).
- The walker's `file-follow-ups` gate, for each follow-up a graph step reports (`--source session --ref follow-up:...`, run by the graph runner; JP-175).
- action-triage's desk watcher, quick capture and `ticket create`, once the phase closes (plan Task 10, a separate pull request in that repository).

## Rules

- Never pass a request's text, only a pointer.
- Never start a run for an item that already has an open one; the entry gate refuses it and the command says so.
- A run that does not start leaves nothing behind: the walker removes the run folder when the entry gate refuses.
