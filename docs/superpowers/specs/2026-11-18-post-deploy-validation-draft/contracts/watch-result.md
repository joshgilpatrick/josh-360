# Watch result

What the `watch-criteria` wait returns as `tally`, and what `validation-verdict` returns as `failed` (the same entries, only those not met).

`tally` is a list, one entry per criterion:

| Field | What it holds |
| --- | --- |
| `id` | The criterion's id from the validation plan |
| `checks` | How many checks were made |
| `passed`, `failed`, `unknown` | How many of them passed, failed, or could not be read |
| `streak` | The current run of passing checks |
| `last` | The last reading: the collector's fields, numbers and short codes only |
| `link` | Where a person can see the same thing (a report on `laptop-status`, a Jira search, a GitHub page), or empty |

The check log beside the watch file has one line per check with the time and every criterion's reading. Neither holds text copied from the system that was read, so neither can hold patient data.
