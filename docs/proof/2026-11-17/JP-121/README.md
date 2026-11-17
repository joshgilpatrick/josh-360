# JP-121 proof: build the ticket creation graph

## Contents

- [Part 1: the shared Jira library](#part-1-the-shared-jira-library)
- [What still needs the laptop](#what-still-needs-the-laptop)

## Part 1: the shared Jira library

JP-121 lands the Jira library every graph build shares (`graphs/gates/lib/jira.py`, `adf.py`) first, in its own pull request, so JP-122 and JP-123 can use it. The two effect scripts the walker calls, `set-flag.py` and `post-comment.py`, stop being stubs. Every Jira answer in these tests is a made-up stand-in.

| Scenario | Proof | Test |
| --- | --- | --- |
| A create reports a key only when Jira confirms; an unconfirmed create is `None`, a refusal raises | `01-jira-library.txt` | `Creating` (7 tests) |
| Reads answer `None` when unknown; ticket text and comments come back as plain text | `01-jira-library.txt` | `Reading` (5 tests) |
| Comments, moves, flags, links and properties are confirmed by a read-back | `01-jira-library.txt` | `Writing` (7 tests) |
| Patient identifiers are stopped before any request, naming the kind and never the text | `01-jira-library.txt` | `test_patient_data_in_a_summary_is_refused_before_any_request`, `test_comment_with_a_patient_identifier_is_refused_and_not_sent`, `test_post_comment_stops_at_a_patient_identifier` |
| The flag and the comment scripts exit 0 only when Jira confirms | `01-jira-library.txt` | `TheTwoEffectScripts` (4 tests) |
| The whole suite passes | `02-suite-library.txt` | `python3 scripts/check.py` |

## What still needs the laptop

The library has only been run against a stand-in. One live check on the laptop, which the later parts of JP-121 do on their own end-to-end run: `set-flag.py --ticket JP-121 --on` then `--off` (the flag field id `customfield_10021` is the one action-triage reads).
