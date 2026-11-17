# JP-145 proof

## Contents

- [Scenarios](#scenarios)
- [Files](#files)

## Scenarios

| Scenario | Result | Proof |
| --- | --- | --- |
| Every call Josh changed matches the tree (@auto) | Pass: A7, A20.1, A31, A33, S4, S5, S6 and S7 dropped, S8.5 kept, as in his saved review | `checks.txt` (`test_every_call_josh_changed_matches_the_tree`) |
| A deferred feature is valid (@auto) | Pass: `later` and `new` accepted; an unknown reason and an empty reply refused | `checks.txt` (`ADeferredFeatureIsValid`) |
| Every comment Josh left has a reply (@auto) | Pass: replies on A7, A9, A16, A20, A31, A33, D1, S4, S8.4 and S8.5; the built page renders all 10 | `checks.txt`, `reply-S8.5.png`, `later-S4.png`, `replaced-A7.png` |
| The suite still passes (@auto) | Pass: `check.py: ok (0 problem(s))` | `checks.txt` |

## Files

- `checks.txt`: the tree check, its 22 tests and the full suite.
- `reply-S8.5.png`: a reply under a comment (the comment text in the screenshot is made-up sample text).
- `later-S4.png`: a feature marked later, with its reason and reply.
- `replaced-A7.png`: prompt settings replaced by the new prompts-and-graphs settings (N1).
