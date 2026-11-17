# JP-143 proof

## Contents

- [Scenarios](#scenarios)
- [Files](#files)

## Scenarios

| Scenario | Result | Proof |
| --- | --- | --- |
| Every feature has a call and a rationale (@auto) | Pass: 115 features, 89 keep, 26 drop, no problems | `checks.txt` (feature_tree.py check and its tests) |
| Every existing feature row is covered (@auto) | Pass: all 51 rows of features.md (A1-A35, S1-S16) are in the tree | `checks.txt` (`test_every_features_md_row_is_in_the_tree`) |
| Josh's answers save (@manual) | Saving was checked against the published page's store (a probe document written, read back and deleted). Josh's own save is checked when he reviews the page. | `page-desktop-light.png`, `page-phone-dark.png` show a changed box and a comment updating the counts |
| The suite still passes (@auto) | Pass: `check.py: ok (0 problem(s))` | `checks.txt` |

## Files

- `checks.txt`: output of the tree check, its tests and the full suite.
- `page-top.png`: the top of the page, with the homes in the one app.
- `page-desktop-light.png`: a ticked box changed and a comment written, desktop, light.
- `page-phone-dark.png`: the same at phone width, dark; no sideways scroll (400 px wide at a 400 px screen).
