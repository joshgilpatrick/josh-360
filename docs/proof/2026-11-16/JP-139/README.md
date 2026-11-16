# JP-139 proof: cap how many times a role step runs, by tier

## Contents

- [Scenarios](#scenarios)

## Scenarios

| Scenario | Proof | Test |
| --- | --- | --- |
| The tiers carry their caps | `01-tiers-carry-caps.txt` | `RunCapScenarios.test_the_tiers_carry_their_caps` |
| A loop that would pass the cap is refused | `02-loop-over-cap-refused.txt` | `RunCapScenarios.test_a_loop_that_would_pass_the_cap_is_refused` |
| A loop inside the cap passes | `03-loop-inside-cap-passes.txt` | `RunCapScenarios.test_a_loop_inside_the_cap_passes` |
| A tier with no cap is refused | `04-tier-without-cap-refused.txt` | `RunCapScenarios.test_a_tier_with_no_cap_is_refused` |
| The suite still passes | `05-suite.txt` | `python3 scripts/check.py` |

The tests are in `graphs/tests/test_check_graph.py`. The walker scenarios belong to JP-114.
