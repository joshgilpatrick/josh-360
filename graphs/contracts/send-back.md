# Send-back

What the `triage-verdict` gate returns as `gaps`: the numbered list the ticket drafter receives (own tickets) or the ticket's author reads in a comment (someone else's ticket).

`gaps` is a list, numbered from 1 in this order: script failures (`ready-checklist`), then kept sign-off defects (`sign-off-defects`). Each entry keeps its source fields and adds `n`, its number.

The comment `send-back` posts, and the one the walker posts before a drafter round, has this shape:

```text
Triage: not Ready yet | run <run id> | next gate: Ready once these are fixed
1. [C6, Acceptance criteria] Scenario "..." has two When lines. Needed: one action per scenario.
2. [J3] "...". The ticket leaves the choice of ... open. Needed: a line in Decisions already made.
```

The first line follows the `result | evidence | next gate` rule for ticket comments. The comment is the marker the `ready-check` gate uses for C12: a send-back comment newer than the ticket's last edit means its gaps are still open.
