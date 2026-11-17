# JP-153 proof

Parallel PRs no longer conflict on one shared file, and a push to a labelled PR reruns the suite.

| Scenario | Proof |
| --- | --- |
| Two PRs that record decisions merge cleanly | `01-tests.txt`: `test_two_prs_that_record_decisions_merge_cleanly` builds two branches that each add a decisions file, a job and a deletion-list row, merges one into `main`, then `main` into the other: no conflict, both sides kept. `test_without_the_attribute_the_same_appends_do_conflict` removes `.gitattributes` and shows the same appends conflict, so the attribute is what removes it. |
| The suite checks the decisions files | `01-tests.txt` (`TestChecker`): a row for another ticket, a row left in the old table, a bad name, a bad date and a short row are each refused with the file the row belongs in. `03-decisions-check.txt` is the real folder passing. |
| A merge-main push reruns the suite | `01-tests.txt` (`TestWorkflow`): the workflow lists `synchronize` and its `if` accepts the three review labels. |
| A push to an unlabelled PR runs nothing and cancels nothing | `01-tests.txt`: the concurrency group sends that event to its own `-ignored-` group. |
| Whole suite | `02-suite.txt`. |

Not provable here: the live GitHub behaviour of the workflow. It shows on this PR's own runs (a push after the label is added must start a `suite` run).
