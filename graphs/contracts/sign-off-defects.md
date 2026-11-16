# Sign-off defects

What the `sign-off` role returns as `defects`, and what the `check-sign-off` gate keeps as `kept`.

`defects` is a list. Each entry:

| Field | What it holds |
| --- | --- |
| `item` | One of `J1` to `J5` (see the sign-off role's instructions) |
| `quote` | Words copied exactly from the ticket version that was judged |
| `problem` | One sentence: why a worker would guess or fail |
| `needed` | One sentence: what the author must add or change |

`check-sign-off` keeps an entry only if `item` is J1 to J5, `quote` appears in that ticket version (ignoring case and runs of spaces), and `problem` and `needed` are not empty. Dropped entries are written to the run record with the reason and never reach the author.
