# JP-156 proof: a walker question can be answered in the Needs you tab

## Contents

- [What was wrong](#what-was-wrong)
- [Proof](#proof)

## What was wrong

The JP-121 laptop check parked a run on a question and the Needs you tab never delivered Josh's approval. The walker wrote each question with a deadline equal to the time it asked. The app refuses an answer once the time has reached the deadline ("This question is no longer waiting"), so the question was dead on arrival. A headless question has no deadline: action-triage writes `9999-12-31T23:59:59.000Z` for it, and the walker now does the same.

## Proof

Made-up question, no real data.

| Scenario | Proof | Test |
| --- | --- | --- |
| A parked question is headless and its deadline is the far-future value; parking again keeps the record unchanged | `01-walker-tests.txt` (the test failed with the old deadline before the fix) | `test_the_needs_you_tab_would_accept_an_answer_to_a_parked_question` |
| Parking the same step again keeps an answer Josh already gave | `01-walker-tests.txt` | `test_parking_the_same_step_again_keeps_an_answer_josh_already_gave` |
| A parked question is still answered and picked up by the walker | `01-walker-tests.txt` | the `Asking` tests |
| The whole suite passes | `02-suite.txt` | `python3 scripts/check.py` |

Still owed on the laptop: park one made-up run and answer it in the Needs you tab.
