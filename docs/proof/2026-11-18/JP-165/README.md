# JP-165 proof: the Validation section and the Ready check

## Contents

- [Scenario to proof](#scenario-to-proof)
- [How to run it](#how-to-run-it)
- [Results](#results)

## Scenario to proof

Each of the ticket's five `@auto` scenarios is a named test.

| Scenario | Test |
| --- | --- |
| A complete Validation section is read | `graphs/tests/test_validation_section.py`, `Reading.test_first_example_reads` (and `test_events_example_reads`) |
| A section the script cannot read names each problem | `graphs/tests/test_validation_section.py`, `Reading.test_daily_is_v3_and_names_the_line_and_the_form`; through the gate: `graphs/tests/test_triage_gates.py`, `TheReadGates.test_daily_fails_v3_through_ready_check`; through ticket creation: `graphs/tests/test_gate_ticket_complete.py`, `test_proposal_with_an_unreadable_validation_names_the_item` |
| A criterion naming an unknown collector is refused | `Reading.test_unknown_collector_is_v5`; `TheReadGates.test_unknown_collector_fails_v5_through_ready_check` |
| A Story with no Validation section is not Ready | `graphs/tests/test_triage_units.py`, `TheValidationItems.test_story_with_no_validation_section_fails_v1`; `test_gate_ticket_complete.py`, `test_proposal_without_validation_is_fixable` |
| A drafted ticket carries its Validation section into Jira | `graphs/tests/test_gate_ticket_complete.py`, `TheRenderedValidation.test_rendered_no_reads_back` (and `test_rendered_yes_reads_back`) |

Beyond the scenarios: `Reading.test_each_item_fails_alone` fails each of V1 to V7 on its own, `test_argument_must_match_whole` guards the whole-string rule, `test_validation_block_is_not_an_acceptance_scenario` keeps the Validation scenarios out of C4 to C6 and the build spec's scenario list, and `TheValidationItems.test_sign_off_takes_a_j6_defect` covers J6. The format documents are checked by `TheContract.test_contract_table_lists_every_collector_and_field`.

## How to run it

From the repository root:

```text
python3 -m unittest discover -s graphs/tests -p "test_validation_section.py"
python3 -m unittest discover -s graphs/tests
python3 scripts/check.py
```

## Results

Run on 18 November 2026 in a cloud session, Python 3.13 (the code uses only what Python 3.9 has):

- `graphs/tests`: 806 tests, OK.
- `python3 scripts/check.py --fast`: `check.py: ok (0 problem(s))`.
- Full `python3 scripts/check.py`: see the pull request.
