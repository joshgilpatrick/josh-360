# JP-199 proof: the Needs you card asks the drafter's question

## Contents

- [What broke](#what-broke)
- [What changed](#what-changed)
- [What was run](#what-was-run)
- [Before and after](#before-and-after)
- [On the laptop](#on-the-laptop)

## What broke

On 20 November, JP-116's triage run posted a Needs you card that read "JP-116 needs one answer from you before it can be Ready. The question is on the ticket.", with the options `answered` and `park`. Josh: "this isn't how the action-triage card is meant to be used." Choosing `answered` also handed the drafter the word "answered" as Josh's answer.

## What changed

- `graphs/gates/post-question.py` still posts the question on the ticket. It now also gives the card two outputs: `card`, the question with its recommendation and reason, and `options`, the recommendation as an answer Josh can choose. Both are declared on `post_question` in `graphs/flows/triage.yaml`, and the compiled copy is rebuilt.
- `ask_josh`'s own text no longer sends Josh to the ticket.
- The walker (`graphs/tools/walker_lib/runner.py`, `card_options`) puts an `options` output from a step above an ask on its card, before the ask's choices. When it does, the bare `answered` choice is left off. Choosing an offered option counts as `answered`: its label is saved for the next session and posted on the ticket as "Josh's answer: <text>", exactly as a typed answer is.
- Asks with nothing offered, such as the development graph's, are unchanged.
- The rule is in `graphs/CONVENTION.md` ("Asking Josh") and both design specs. The choices made while building are in [`docs/decisions/JP-199.md`](../../../decisions/JP-199.md).

## What was run

In a cloud session on 20 November 2026, on made-up ticket JP-9001, with the real walker and gate scripts and the folder-backed fake Jira. A short script drove the triage graph to `ask_josh` with a drafter answer of `needs_josh`, read the Needs you record, chose the card's first option, and took one more step. It ran on this branch ([`after/`](after/)) and on the branch it is built on, JP-195 at 61bd872 ([`before/`](before/)).

- `python3 -m unittest test_triage_gates test_triage_run` (from `graphs/tests`): 72 tests pass, including the three acceptance scenarios.
- `python3 -m unittest tests.test_walker_card_options`: 5 tests pass.
- `python3 scripts/check.py`: 0 problems.

## Before and after

| | Before ([`before/card.json`](before/card.json)) | After ([`after/card.json`](after/card.json)) |
| --- | --- | --- |
| Card text | "JP-9001 needs one answer from you before it can be Ready. The question is on the ticket." | "JP-9001 needs one answer from you before it can be Ready." then "Which file holds the first step?" and "Recommended: laptop/install.py, because it holds STEPS." |
| Options | `answered`, `park` | `laptop/install.py` (described "Recommended, because it holds STEPS."), `park`, and the free-text box |
| Josh chooses the first option | the drafter's answer is "answered" | the drafter's answer is "laptop/install.py" |
| On the ticket | the question only | the question, then "Josh's answer: laptop/install.py" |
| Next step | `revise`, attempt 2 | `revise`, attempt 2 |

## On the laptop

Nothing to do by hand. The `graph-runner` job uses the new walker after the merge. JP-116's run that is already parked keeps its old card, and Josh answers it as planned.
