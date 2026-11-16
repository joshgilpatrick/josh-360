# JP-140 proof: record what every graph run needs for scoring

## Contents

- [Scenarios](#scenarios)

## Scenarios

| Scenario | Proof | Test |
| --- | --- | --- |
| The new ledger fields are allowed | `01-ledger-fields-allowed.txt` | `ScoringScenarios.test_the_new_ledger_fields_are_allowed` |
| Every end is classified | `02-every-end-classified.txt` | `ScoringScenarios.test_every_end_is_classified` |
| An unclassified end is refused | `03-unclassified-end-refused.txt` | `ScoringScenarios.test_an_unclassified_end_is_refused` |
| An unknown classification is refused | `04-unknown-class-refused.txt` | `ScoringScenarios.test_an_unknown_classification_is_refused` |
| The suite still passes | `05-suite.txt` | `python3 scripts/check.py` |
| Review fix: a refused exit gate has a fixed end | `06-exit-refused-reserved.txt` | `Rules.test_exit_refused_is_reserved_and_not_written_in_end_states` |

The tests are in `graphs/tests/test_check_graph.py`; the extra rule tests (a missing field, an end the graph does not have, a loop that is not an end, every class accepted) sit under `Rules`. The new bad samples are `unclassified-end`, `unknown-end-class`, `unknown-end-name` and `missing-end-states` in `graphs/tests/fixtures/bad/`. Writing the fields at run time is JP-114.
