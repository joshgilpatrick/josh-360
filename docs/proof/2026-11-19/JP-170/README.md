# JP-170 proof: what a ticket's sessions cost, step by step

## Contents

- [What was built](#what-was-built)
- [Scenarios and their tests](#scenarios-and-their-tests)
- [Made-up example](#made-up-example)
- [Check on the laptop after the merge](#check-on-the-laptop-after-the-merge)

## What was built

- `python3 ledger/measures.py ticket <KEY>` (`--json` for the data): every session on a ticket, the graph step each did, its own cost, its subagents' cost and the row total, then a ticket total. Code: `ledger/ticket_costs.py`, `ledger/measures.py`.
- Migration `ledger/migrations/0002-step-costs-rolled-up.sql` adds the views `session_subagent_roots`, `session_costs_rolled_up` and `step_costs_rolled_up`. `step_costs` is untouched; `measures.py spend` reads the new view.
- `python3 graphs/runner/runner.py report --run <id>` has a Cost column. The published snapshot carries no cost (a test checks it), so `--from-json` shows a dash and a note.
- Choices made while building: `docs/decisions/JP-170.md`.

## Scenarios and their tests

| Scenario (JP-170) | Test |
| --- | --- |
| Every session on a ticket is listed with its step and cost | `tests/test_ledger_ticket_costs.py` `Listing.test_every_session_is_listed_with_its_step_and_cost`, `test_json_has_the_same_rows_and_the_total` |
| A subagent's cost counts toward the step that started it | `Subagents.test_a_subagent_counts_toward_the_step_that_started_it`, `test_a_nested_subagent_rolls_up_to_the_step_session_once`, `test_a_resume_is_a_session_of_its_own_not_a_subagent` |
| Step costs elsewhere include subagents too | `StepCostsElsewhere.test_spend_shows_the_step_with_its_subagents`; `tests/test_runner_report_cost.py` `test_each_step_shows_its_cost_with_its_subagents`, `test_the_command_shows_the_cost` |
| A session not priced yet is marked, not shown as free | `Pricing.test_a_session_not_priced_yet_is_marked_and_counted`, `test_a_partly_priced_session_shows_its_cost_with_a_mark`, `test_an_unpriced_subagent_makes_its_parent_partly_priced`; `ReportCost.test_a_session_with_no_price_says_not_priced_yet` |
| A ticket with no sessions says so | `Listing.test_a_ticket_with_no_sessions_says_so` |
| Working agents still cannot read cost | `AgentsStillCannotReadCost` (every `ask.py` query, and `ask.py` names none of the new views); `ReportCost.test_a_published_snapshot_has_no_cost_and_the_report_says_so` |

## Made-up example

Output of `python3 ledger/measures.py ticket JP-900` on the test ledger (run R1: `plan` by S1 $1.20, `build` by S2 $3.40 with subagent S2a $0.60, `review` by S4 not priced yet; S3 homed by its branch, $0.75):

```
JP-900: what its sessions cost

Graph  Step              Try  Model  Session    Own    Subagents  Total
dev    plan              1    m-1    sess-0001  $1.20             $1.20
dev    build             1    m-1    sess-0002  $3.40  $0.60      $4.00
dev    review            1    m-1    sess-0004  -                 not priced yet
       not a graph step              sess-0003  $0.75             $0.75

Total: $5.95 for 4 sessions, 1 session not priced yet
```

## Check on the laptop after the merge

`@manual`: run `python3 ~/.josh-360/repo/ledger/measures.py ticket JP-116` against the real ledger and save the output (costs and ids only, no patient data) in this folder as `jp-116-ticket-costs.txt`. The merge installs the migration on the laptop within about 10 minutes (the ledger step backs the database up first).
