# JP-187 proof: the fake Jira refuses what JP refuses

## Contents

- [What was proved](#what-was-proved)
- [Scenarios](#scenarios)
- [What the snapshot found](#what-the-snapshot-found)
- [Not proved here](#not-proved-here)

## What was proved

A fake Jira folder made with `jira_strict.install` holds a snapshot of JP's real workflow and answers 400 for any transition, field, option value, issue type or JQL value JP's real Jira would refuse. Without the snapshot it is the same lenient fake as before. The snapshot was read from real Jira on 20 November 2026, read-only, through the Atlassian connector; the ticket used is made up (`JP-9116`, "Add a made-up chores page"). Run in a cloud session.

Unit test output: [`unit-tests.txt`](unit-tests.txt) (`python3 -m unittest -v test_jira_strict` in `graphs/tests`, 32 tests, all ok).

## Scenarios

| Scenario | Proof |
| --- | --- |
| A known transition is accepted | `AcceptanceScenarios.test_a_known_transition_is_accepted`: the real `move-ticket` gate, run as its own process, moves JP-9116 from Validation to Deployed; the only transition it posted was id `7`, and the ticket now reads `Deployed`, id `10582`. |
| An unknown transition is refused | `test_an_unknown_transition_is_refused`: transition `999` answers 400 "Transition id '999' is not valid for this issue." and the ticket stays in Validation. |
| An unknown field is refused | `test_an_unknown_field_is_refused`: setting `customfield_99999` answers 400 naming the field, and the client raises `JiraError` with status 400. |
| No snapshot keeps today's behaviour | `WithoutSnapshot.test_no_snapshot_keeps_the_lenient_fake` (the same calls are accepted without the file), and the full suite (`python3 scripts/check.py`) passes with no existing test changed. |

Beyond the ticket's four: an option value JP lacks, a field off an issue type's create screen, a Subtask with no parent, another project, a status set as a field, an unknown link type and an unknown JQL status are all refused; every start rule in `graphs/runner/starts.json` is valid JQL for JP; `move-ticket`'s status list equals JP's; the `josh360.route` shape matches what `mark-ready` writes; and `scripts/jira_snapshot.py` rebuilds the committed snapshot from REST-shaped answers while making no write.

## What the snapshot found

- Every JP transition leads from every status (team-managed): the same nine came back from a ticket in each of eight statuses. No ticket sat in Design/Planning to read.
- `customfield_10452`, the second Agent Status id `lib/triage` reads, is not a field on JP; only `customfield_10453` is.
- JP's Repository field (`customfield_10487`) has no `joshgilpatrick/josh-360` option. No gate sets it today, so nothing breaks; a gate that did would be refused by real Jira.

## Not proved here

- The snapshot script against real Jira's REST API: the cloud has no Jira token. It is read-only and runs on the laptop with the gates' credentials (`python3 scripts/jira_snapshot.py`).
- The end-to-end run that uses this fake: JP-188.
