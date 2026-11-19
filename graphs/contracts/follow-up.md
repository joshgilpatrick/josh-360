# Follow-up

## Contents

- [What it is](#what-it-is)
- [In a result file](#in-a-result-file)
- [The follow-up file](#the-follow-up-file)
- [What happens next](#what-happens-next)

## What it is

Work a graph step found outside its ticket (JP-175). A step session never does that work: it reports it, a script files it as a ticket through intake, and the sprint lead or the epic lead is told. The code is `graphs/gates/lib/follow_ups.py`.

## In a result file

A role step's result file may carry `follow_ups` beside `outcome` and `outputs`. It is not an output, so no graph declares it, and every role step may use it.

```json
{
  "outcome": "built",
  "outputs": {"build_report": "work/build.md"},
  "follow_ups": [
    {"summary": "The install script has no dry-run flag", "why": "This ticket changes the runner, not the installer.", "blocks": false}
  ]
}
```

| Field | Type | Rule |
| --- | --- | --- |
| `summary` | text | One line, 1 to 120 characters: the work, as a ticket summary would say it |
| `why` | text | 1 to 300 characters: why it is outside this ticket |
| `blocks` | boolean | `true` only when this ticket cannot be finished without it |

At most 5 entries, and no other field. The walker's `record` refuses a result that breaks these rules, as it refuses an undeclared output. Made-up example; no patient data, as everywhere.

## The follow-up file

`record` saves each entry as `$JOSH360_RUNS/<run id>/follow-ups/<step>-<attempt>-<n>.json`: the three fields above plus `id`, `run`, `step`, `attempt`, `origin` (the run's ticket), `state`, `intake_run`, `key` and `recorded_at`. The file is the only place the step's words are kept. Everything else names it by its pointer, `follow-up:<run id>:<file id>`.

| State | Means |
| --- | --- |
| `new` | Recorded, not yet filed |
| `submitted` | `file-follow-ups` started a ticket-creation run for it (`intake_run`) |
| `filed` | That run created a ticket or commented on an open one; `key` holds it |
| `dropped` | That run ended with no ticket (Josh dropped it at the card), or intake refused it |
| `resolved` | It blocked its ticket, and `key` is now Done or Cancelled |

## What happens next

1. On its next `next`, the walker runs the gate `file-follow-ups` for each `new` file: it reads the origin ticket's space and epic and calls `graphs/intake/submit.py --source session --ref <pointer> --space <space> --parent <epic>` (pointer only), for the graph runner to advance.
2. The ticket-creation graph reads the file, drafts, checks for a duplicate and asks Josh on its one card. Its `create-tickets` gate labels the ticket `graph-follow-up` and, when it blocks, links it Blocks the origin ticket; `link-source` writes the key back into the file.
3. A blocking follow-up holds its run before its next step: the walker answers `waiting`, `runner.py status` shows `waiting on <key>`, until the key is Done or Cancelled, or the follow-up is dropped. A non-blocking one never holds the run.
4. The runner tells the lead, by script: a filed follow-up through `sprint.py handoff` (sprint lead) or `agent-manager send` (epic lead), a dropped one by `agent-manager send` (`graphs/runner/runner_lib/leads.py`).
