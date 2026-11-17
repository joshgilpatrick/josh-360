# JP-144 proof

## Contents

- [Scenarios](#scenarios)
- [Files](#files)

## Scenarios

| Scenario | Result | Proof |
| --- | --- | --- |
| Josh can see the whole system on one page (@manual) | Shown: the layers, the data flow, the salvage map and the phase split, in light and dark and at phone width (no sideways scroll; the two drawings scroll inside their own frames). Published at https://claude.ai/artifact/Ae3bfNBPprWqg4iZYUPbgM. Josh's own look is the manual half. | `page-01-parts.png` to `page-08-phone.png` |
| A copy lives in the repo (@auto) | Pass: `docs/design/architecture/architecture.html`, checked up to date with the feature tree | `checks.txt` (`ACopyLivesInTheRepo`, `TheSalvageMapCoversEveryFeature`) |
| The suite still passes (@auto) | Pass: `check.py: ok (0 problem(s))` and all tests | `checks.txt` |

## Files

- `checks.txt`: the architecture page check, the full suite and the page's 9 tests.
- `page-01-parts.png`: the five layers, each part tagged with its phase and the feature ids it is built from.
- `page-02-flow.png`: one ticket's trip, and where each fact lands in the ledger.
- `page-03-salvage-counts.png`: every source by fate (133 rows: 116 from the feature tree, 17 laptop rows).
- `page-04-salvage-atlas-detail.png`: Session Atlas's features by fate, with S8 opened to show its parts.
- `page-05-phases.png`: phase 1, 2 and 3 tickets, what runs unchanged meanwhile, and each gate.
- `page-06-points.png`: three points the picture raises, each with a recommendation.
- `page-07-parts-dark.png`: the layers in the dark theme.
- `page-08-phone.png`: the top of the page at 400 px wide.
