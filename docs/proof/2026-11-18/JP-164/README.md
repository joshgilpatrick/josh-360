# JP-164 proof: the design for post-deploy validation

## Contents

- [Scenarios](#scenarios)
- [Commands run](#commands-run)
- [Every path, replayed](#every-path-replayed)

## Scenarios

The spec is [`docs/superpowers/specs/2026-11-18-post-deploy-validation-design.md`](../../../superpowers/specs/2026-11-18-post-deploy-validation-design.md).

| Scenario (from the ticket) | Tag | Proof |
| --- | --- | --- |
| The spec defines the Validation section: each field with one filled-in example, and how a script reads it without a model | @manual | Spec, "The Validation section of a ticket" (field table, three examples) and "How a script reads the section". For Josh to read. |
| The spec gives each status one meaning, and every move into and out of Deployed names the script or thread that makes it | @manual | Spec, "The three statuses" and "Who moves a ticket into and out of Deployed". For Josh to read. |
| The validation graph is drawn step by step: kind, tier where a model is used, outcomes; a check that needs no judgment calls no model; every end state is classed | @manual | Spec, "The flow at a glance" and "The steps" (eleven steps, none uses a model, so none has a tier; the table of ends and scores). For Josh to read. |
| The failure and no-data paths are designed | @manual | Spec, "When the criteria are not met" and "When no data arrives, and the one question". For Josh to read. |
| The draft graph passes the checker | @auto | [Commands run](#commands-run): `check_graph: ok (1 graph(s))`, exit 0 |
| Josh approves the spec | @manual | Waiting for Josh in the thread "JP-164 Design post-deploy validation". |

## Commands run

Cloud session, 18 November 2026, Python 3.13 with PyYAML.

```text
$ python3 graphs/tools/check_graph.py --root docs/superpowers/specs/2026-11-18-post-deploy-validation-draft
check_graph: ok (1 graph(s))
exit 0

$ python3 graphs/tools/check_graph.py
check_graph: ok (4 graph(s))
```

The second run shows the four live graphs are untouched: the draft sits outside `graphs/flows/`, so the walker and the runner never see it.

## Every path, replayed

The checker proves the draft's shape. It does not prove that each path ends where the spec says. `replay_paths.py`, beside this file, feeds the walker's own engine (`graphs/tools/walker_lib/engine.py`) the outcome each step would give, for the twelve paths the spec describes, and compares the end each run reached with the designed one. A step marked `!` was reached because a loop hit its limit.

```text
$ python3 docs/proof/2026-11-18/JP-164/replay_paths.py
Criteria met
    ends: finished
    read_criteria=watch > start_watch=started > watch=met > verdict=met > close=closed
Nothing to watch
    ends: close_unwatched.closed
    read_criteria=not_needed > verdict=not_needed > close_unwatched=closed
Josh moves the ticket during the watch
    ends: watch.left_deployed
    read_criteria=watch > start_watch=started > watch=left_deployed
Section unreadable, Josh fixes it, watch again, met
    ends: finished
    read_criteria=unreadable > verdict=undecided > decide=watch_again > read_criteria=watch > start_watch=started > watch=met > verdict=met > close=closed
No data, Josh accepts
    ends: close_accepted.closed
    read_criteria=watch > start_watch=started > watch=no_data > verdict=undecided > decide=accept > close_accepted=closed
No data, Josh stops
    ends: hold.held
    read_criteria=watch > start_watch=started > watch=no_data > verdict=undecided > decide=stop > hold=held
A manual criterion, Josh confirms
    ends: close_accepted.closed
    read_criteria=watch > start_watch=started > watch=needs_josh > verdict=undecided > decide=accept > close_accepted=closed
Not met, fix ships, met
    ends: finished
    read_criteria=watch > start_watch=started > watch=not_met > verdict=not_met > file_bug=filed > await_fix=shipped > read_criteria=watch > start_watch=started > watch=met > verdict=met > close=closed
Not met, fix cancelled, Josh accepts
    ends: close_accepted.closed
    read_criteria=watch > start_watch=started > watch=not_met > verdict=not_met > file_bug=filed > await_fix=cancelled > decide=accept > close_accepted=closed
Not met, Josh moves the ticket while the fix is open
    ends: await_fix.left_deployed
    read_criteria=watch > start_watch=started > watch=not_met > verdict=not_met > file_bug=filed > await_fix=left_deployed
Not met twice, second fix ships, Josh allows a third watch, met
    ends: finished
    read_criteria=watch > start_watch=started > watch=not_met > verdict=not_met > file_bug=filed > await_fix=shipped > read_criteria=watch > start_watch=started > watch=not_met > verdict=not_met > file_bug=filed > await_fix=shipped > !decide=watch_again > read_criteria=watch > start_watch=started > watch=met > verdict=met > close=closed
Not met twice, second fix ships, Josh stops
    ends: hold.held
    read_criteria=watch > start_watch=started > watch=not_met > verdict=not_met > file_bug=filed > await_fix=shipped > read_criteria=watch > start_watch=started > watch=not_met > verdict=not_met > file_bug=filed > await_fix=shipped > !decide=stop > hold=held

12 paths, 0 ended somewhere other than designed
```

Also read through the Jira API on 18 November 2026: the start rule's search, `project = JP AND status = Deployed AND Flagged is EMPTY`, is accepted and returns no tickets, which is right today (nothing is in Deployed).
