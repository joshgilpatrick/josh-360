# Validation plan

What `read-validation` returns as `criteria`, and what `start-watch` writes to the watch file with the timetable around it.

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

The watch file (`<run>/work/watch/round-<n>.json`) holds `criteria` plus the timetable and the round's times:

| Field | What it holds |
| --- | --- |
| `starts`, `check_every_hours`, `complete_when`, `give_up_days` | The section's timetable, as `read-validation` returned it |
| `fail_after` | Failing checks in a row that end the watch early: the number on the "Fail after" line, or 3 |
| `section_version`, `round` | The hash of the section, and which round this is |
| `started_at` | When the round started |
| `begins_at` | When the watch begins: `max(started_at, the moment the Starts line names)`. Empty while the Starts line waits on another ticket; the watch script then records the time as a `began` line at the top of the check log |
| `first_check_at` | `begins_at` plus one "Check every". Empty while `begins_at` is. "Give up after" is counted from `begins_at` too |
