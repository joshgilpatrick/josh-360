# Validation plan

## Contents

- [The criteria](#the-criteria)
- [The watch file](#the-watch-file)
- [The check log](#the-check-log)

What `read-validation` returns as `criteria`, and what `start-watch` writes to the watch file with the timetable around it.

## The criteria

`criteria` is a list, one entry per `@validate` scenario, in the order the ticket lists them:

| Field | What it holds |
| --- | --- |
| `id` | `V1`, `V2`, ... by position |
| `name` | The scenario's name |
| `collector` | The collector named in the `When the watch reads ...` line |
| `argument` | The rest of that line, as text. It is data handed to the collector, never run |
| `checks` | A list of `{field, comparison, value}`, one per `Then` or `And` line. Empty for a manual criterion |
| `manual` | `true` when the scenario is also tagged `@manual` |
| `statement` | For a manual criterion: the words after `Then Josh confirms that` |

## The watch file

The watch file (`<run>/work/watch/round-<n>.json`, written once by `start-watch`) holds `criteria` plus the timetable and the round's times:

| Field | What it holds |
| --- | --- |
| `ticket_key` | The ticket in Deployed that the watch is on |
| `starts`, `check_every_hours`, `complete_when`, `give_up_days` | The section's timetable, as `read-validation` returned it |
| `starts_kind` | `deployed`, `date` or `ticket`: which kind of Starts line it was |
| `starts_date`, `starts_ticket` | The date (`2026-11-25`) or the ticket key the Starts line names; empty for the other kinds |
| `complete_kind`, `complete_n` | `streak` (n checks in a row pass) or `events` (after n events), and the n |
| `fail_after` | Failing checks in a row that end the watch early: the number on the "Fail after" line, or 3 |
| `section_version`, `round` | The hash of the section, and which round this is |
| `started_at` | When the round started |
| `begins_at` | When the watch begins: `max(started_at, the moment the Starts line names)`. Empty while the Starts line waits on another ticket; the watch script then records the time as a `began` line at the top of the check log |
| `first_check_at` | `begins_at` plus one "Check every". Empty while `begins_at` is. "Give up after" is counted from `begins_at` too |

## The check log

`round-<n>.checks.jsonl` beside the watch file has one JSON object per line. Only `watch-criteria` writes it.

| `kind` | Other keys | Written when |
| --- | --- | --- |
| `began` | `at` | The ticket the Starts line names is first read in Done |
| `look` | `at`, `status` (the watched ticket's status, or `unknown`), `starts_ticket` (`done`, `open`, `cancelled`, `missing`, `unknown` or empty) | An hourly look, and before every check |
| `check` | `at`, `n` (1, 2, ...), `result` (`pass`, `fail`, `unknown`, or `waiting` in events mode), `criteria` (`{"V1": {"result": "pass", "fields": {...}, "link": ""}}`, measured criteria only) | A check is taken |
| `end` | `at`, `result` (`met`, `needs_josh`, `not_met`, `no_data`, `left_deployed`), `reason` (`streak`, `events`, `fail_after`, `gave_up`, `never_began`, `starts_cancelled`, `starts_missing`, `left`), `tally` | The watch ends; always the last line |
