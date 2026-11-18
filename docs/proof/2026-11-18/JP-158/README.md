# JP-158: docs brought up to date, and the verification feature map

## Contents

- [Scenarios and proof](#scenarios-and-proof)
- [The end-to-end run](#the-end-to-end-run)
- [What the doc review found](#what-the-doc-review-found)
- [Files](#files)

Everything here was done in the cloud on made-up sample data. The sandbox laptop had its own home folder, a local stand-in for GitHub and no credentials; nothing touched a real home folder, Jira or GitHub.

## Scenarios and proof

| Scenario | Proof |
| --- | --- |
| Every doc with a "Contents" section has links that resolve (`@auto`) | `scripts/docs_check.py` check 1 checks every anchor and relative link in all 198 tracked Markdown files; it runs inside `python3 scripts/check.py`, which passes. Tests: `tests/test_docs_check.py` (`test_broken_links_and_anchors_fail`, `test_links_in_code_are_not_checked`). |
| Every top-level folder has a README (`@auto`) | `docs_check.py` check 2. New: `scripts/README.md`, `tests/README.md`, `docs/README.md`. Test: `test_folder_without_readme_fails`. |
| The skill has its name, a description naming the app and its surfaces, and the five sections, with no placeholder (`@auto`) | `docs_check.py` check 4. Tests: `test_skill_shape`, `test_description_must_name_the_surfaces`, `test_sandbox_must_be_executable`. |
| Each feature file has the four sections and the index lists every file (`@auto`) | `docs_check.py` check 5. Tests: `test_feature_sections_must_match`, `test_driving_section_must_name_the_harness`, `test_unindexed_feature_fails`. |
| The generated skill works end to end, and its evidence survives cleanup (`@e2e`) | [The end-to-end run](#the-end-to-end-run) below; the evidence is in `verify-josh-360/`. |
| A cold reader finds their way from the README to the architecture overview and the feature map (`@manual`) | `README.md` links to `docs/architecture.md` under "The parts" and "Where to read next", and to the feature map under "Proving a feature works"; `docs/architecture.md` links back to both. Josh to confirm by reading. |

Suite: `python3 scripts/check.py` passes, with 15 new tests for this ticket.

## The end-to-end run

Run `jp158-proof` followed `.claude/skills/verify-josh-360/features/session-ledger.md` from a clean checkout at commit `e6037e1`:

| Step | Evidence file | Result |
| --- | --- | --- |
| Launch: the sandbox laptop installs | `launch-install.json` | `laptop/install.py` exit 0 |
| Doctor: the sandbox is healthy | `doctor.json` | `ok: true`; every required check passes; origin is the sandbox's stand-in |
| A made-up session on branch `JP-9001-sample-work` | `seed-verify-sess-0001.json` | sample folder, transcript and hook payloads written |
| SessionStart and SessionEnd hooks | `hook-session-start.json`, `hook-session-end.json` | both exit 0 |
| The spool holds two lines | `spool.json` | a start and an end line |
| The recorder writes the session | `record.json` | 1 session, 1 episode, 1 home |
| The ledger row | `ledger-rows.json` | branch `JP-9001-sample-work`, end reason `session-end` |
| Agents can find it | `ask-find.json`, `ask-home.json` | found by folder; home is ticket JP-9001, by branch |
| No message text is kept | `no-text.json` | `grep` for the transcript's sample answer finds nothing (exit 1) |
| Recording again adds nothing | `record-again.json` | every count 0 |

Cleanup then removed the sandbox folder and left the evidence folder in place, as the Cleanup step requires.

## What the doc review found

Every living document was read against the code. These were out of date and are now fixed, one commit each:

| File | What was wrong |
| --- | --- |
| `AGENTS.md` | Missing subagents, loose-ends flags, `status.py show <report>`, `conventions.py export-json`, the gates and intake folders; now also names the new docs and the skill. |
| `README.md` | Rewritten: what josh-360 is, its parts, every folder, how to run the checks, where to read next. |
| `apps/README.md`, `apps/session-atlas/README.md` | Session Atlas now lives here; `recompute-projects` does not run today. |
| `conventions/README.md`, `conventions/tickets.md` | The JSON copies and `export-json` were not mentioned. |
| `docs/surface-map.md` | No row for the job runner or the hook dispatcher. |
| `graphs/CONVENTION.md`, `graphs/README.md` | The intake and runner folders, the contracts list and `JOSH360_GRAPH` were missing. |
| `graphs/contracts/README.md`, `graphs/contracts/ready-checklist.md` | Listed some contracts; described the checklist as not built. |
| `graphs/flows/README.md`, `graphs/gates/README.md` | Gate states and the gate list were behind the code. |
| `graphs/roles/README.md`, `graphs/agents/README.md` | Did not list every role and agent. |
| `jobs.yaml` | Comments described an older shape (comments only). |
| `laptop/README.md` | The install script's five steps were not named. |
| `ledger/README.md`, `ledger/migrations/README.md` | Missing files and the walker's tables; implied migrations exist. |
| `.github/PULL_REQUEST_TEMPLATE.md` | The fast checks did not say `--fast`. |

New: `docs/architecture.md`, `docs/README.md`, `scripts/README.md`, `tests/README.md`, `scripts/docs_check.py` and the `verify-josh-360` skill. Dated records (specs, plans, inventory, source notes, earlier proof) were left as written (`docs/decisions/JP-158.md`).

Code problems the review found are filed as their own tickets rather than fixed here, as the ticket requires.

## Files

- `verify-josh-360/`: one JSON record per command of the end-to-end run (command, folder, exit code, output).
