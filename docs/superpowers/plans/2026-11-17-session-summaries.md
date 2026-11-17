# Session summaries (JP-108) Implementation Plan

## Contents

- [Goal and constraints](#goal-and-constraints)
- [Where this fits](#where-this-fits)
- [Rules the build follows](#rules-the-build-follows)
- [Tasks](#tasks)
- [Out of scope](#out-of-scope)

## Goal and constraints

When a session goes quiet, write about five lines into `session_summaries` that say what it was about and how it ended, so a session with no ticket can be found and picked up again. No model call when there is enough to copy; one small cheap-tier call when there is not; never a call per turn; nothing that depends on a closeout step.

JP-108 was `Not Started` when this build began. Its blocker (JP-107) is Done and its only open question was answered at the JP-106 sitting (Jira comment of 16 November; `docs/decisions.md`). Josh ruled on 17 November that everything in epic JP-94 is fair game once it is not blocked, so the build starts without the backlog and sprint rule. Code is built and tested in the cloud on made-up sample data only.

## Where this fits

- `session_summaries` and `model_calls` already exist in `ledger/schema.sql` (JP-99, JP-148): one summary row per episode, `method` copied or model, at most five lines and 800 characters, `lines_withheld`, versioned. This ticket writes them and adds no migration.
- "Gone quiet" is the recorder's rule (`ledger/record.py`): `SessionEnd` fired, or the transcript has not grown for 30 minutes. An episode row exists only after that, so the summary job reads episodes and needs no rule of its own. A resumed session that goes quiet again gets episode 2, and episode 2 gets its own summary: that is the rewrite.
- `ledger/ask.py` already reads `current_session_summaries` for `find`, `ticket` and `changes`.

## Rules the build follows

1. **Enough to copy** means the first line of the first message is usable, or both the title and a STATE.md timeline entry are. Josh's answer at JP-106: the first line is copied (160 characters at most) after the patient-data screen, and the call is kept for a session whose first line is empty or withheld and whose title and STATE.md are too thin.
2. **Thin** means not enough. One call on the `cheap` tier from `graphs/tiers.yaml`; a second attempt only after a failed first one (it uses the tier's next model); then keys-and-counts lines, method `copied`. At most three calls per pass, and none for an episode older than 14 days.
3. **A `.phi` folder** gets lines built only from the ledger's own keys and counts, and never a model call.
4. Every free-text piece goes through `ledger.text.short_text` (the shared screen). A piece that fails is left out and counted in `lines_withheld`.
5. A check (`summary.check_lines`) rejects more than five lines or more than 800 characters before anything is written; the schema refuses it too.
6. A model call's cost is recorded in `model_calls` in the same transaction as its summary row.
7. The summary job is its own job (`ledger-summary`, every 5 minutes, after `ledger-record`), so the recorder stays free of model calls and network use. The call is `claude -p` on the laptop, run with no tools, no saved session and an environment flag that makes the session hooks write nothing, so the call never becomes a session of its own.
8. Existing summary rows, including withdrawn ones, are never touched: an episode with any summary row is skipped, and a withdrawn summary is replaced with the next version by `ledger/correct.py` and the person who withdrew it.

## Tasks

1. **Sources** (`ledger/summary_sources.py`): `first_line(transcript)`, `excerpt(transcript)` and `timeline(state_file)`. These are the only readers of message text; the first two read a bounded part of the transcript and skip tool results and injected tags. Tests with made-up transcripts.
2. **Composer** (`ledger/summary.py`): material, `is_thin`, `compose`, `check_lines`, and the five-line layout (Asked, About, Status, Work, Ended). Tests for each scenario below.
3. **Driver and model call** (`ledger/summary.py`): `summarise_pending`, the model call parsing, the `claude -p` caller, the attempt cap and the cost row. Tests with a fake caller and a fake `claude` script.
4. **Job and hook guard**: `ledger-summary` in `jobs.yaml`; the spool hook writes nothing when `JOSH360_INTERNAL_CALL=1`.
5. **Docs and proof**: `ledger/README.md`, `docs/decisions.md`, proof under `docs/proof/2026-11-17/JP-108/`.

Gherkin scenarios of the ticket map to tests in `tests/test_ledger_summary.py`: enough material means no call; thin material means exactly one call and its cost recorded; a resumed session is summarised again; a closed terminal still gets its summary.

## Out of scope

The debrief form (JP-113, which later shares this call), any report or message to Josh, and changing how `ask.py` shows a summary.
