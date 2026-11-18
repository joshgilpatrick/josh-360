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

The watch file (`<run>/work/watch/round-<n>.json`) holds `criteria` plus `starts`, `check_every_hours`, `complete_when`, `give_up_days`, `section_version`, `round`, `started_at` and `first_check_at`.
