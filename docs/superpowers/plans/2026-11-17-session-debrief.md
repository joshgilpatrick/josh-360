# Session debrief form (JP-113) Implementation Plan

## Contents

- [Goal and constraints](#goal-and-constraints)
- [Where this fits](#where-this-fits)
- [Rules the build follows](#rules-the-build-follows)
- [Tasks](#tasks)
- [Out of scope and what stays owed](#out-of-scope-and-what-stays-owed)

## Goal and constraints

When a session that earns it goes quiet, one small model call with no tools fills in a fixed form: how the session ended (from a short list) and up to five moments of friction. The call is the same call that writes the summary lines, so an episode gets at most one model call. The form stores codes and pointers, never text. Nothing runs per turn, and nothing depends on a closeout step.

JP-113 was `Not Started`, and its own text says it starts no sooner than two weeks after the friction facts are installed (JP-112 merged on 17 November 2026). Josh ruled on 17 November that everything in epic JP-94 is fair game once nothing blocks it, so the build starts now. That ruling does not create two weeks of real rows. So the build ships the kinds Josh listed as a provisional form (`form_version` ends in `-provisional`) and a command that finalises it from the real rows only when they cover at least two weeks. That last step is owed and is named on the ticket.

## Where this fits

- `debriefs`, `debrief_moments` and `model_calls` (with the purposes `debrief` and `summary-and-debrief`) already exist in `ledger/schema.sql`; this ticket adds no migration.
- `ledger/summary.py` (JP-108) already makes the one cheap-tier call for a thin episode. The JP-108 thread said JP-113 reuses `claude_caller` and `CallResult` and changes the call's purpose to `summary-and-debrief`.
- `ledger/friction.py` (JP-112) writes the facts the earning rule reads. `ledger/codes.json` already holds the kind and ending lists.
- Kinds, endings and the earning thresholds are data (`codes.json`, `ledger/debrief_form.json`), so tuning them is a merge.

## Rules the build follows

1. **Who earns a debrief** (`debrief.earns`): an episode that is part of a graph run (its session started by the walker, or named by a step), or whose facts reach a threshold in `debrief_form.json` (interrupts, a repeated failed command, several failed commands, context exhausted, several compactions, a U-turn or dead end, several unprompted messages). Anything else gets facts only. A `.phi` folder, a subagent and a session that is not recent (14 days) never earn one.
2. **One call per episode, from the ledger.** An episode with a `model_calls` row made after it went quiet is never called again. A call that fails to run (nothing came back) is retried as JP-108 does; a call whose output is rejected is not.
3. **Combined or alone.** A thin episode that earns gets one call that writes both (`summary-and-debrief`). An episode with a summary that can be copied and that earns gets a debrief-only call (`debrief`). A thin episode that does not earn gets JP-108's summary-only call, unchanged.
4. **The input** (`ledger/debrief_sources.py`, the second and last reader of message text): Josh's messages (a script's prompts for a scripted session), the agent's replies, error lines and the STATE.md record, with tool output left out. Every piece is cut and goes through the patient-data screen; one that fails is left out. Turns get handles (`T1`, `T2`, ...) so the model can point without quoting. When the trimmed copy is over its budget, or the episode was compacted, STATE.md and the saved compaction summaries stand in for the agent's replies.
5. **Only the form is accepted** (`debrief.parse_output`): one JSON object with exactly the form's keys, a listed ending, at most five moments, each with a listed kind, one of six target kinds, a plain identifier as the target (screened) and a handle that was in the input. Anything else is rejected whole and nothing is stored (the summary falls back to the facts lines).
6. **Pointers, not quotes.** A moment stores the transcript line's id, found from its handle by the script.
7. **Transcripts are data.** Text from a session sits between markers, markers inside it are defused, and the output check means the model can only choose codes and handles.
8. **The form follows the data.** `python3 ledger/debrief.py finalise-form` reads the date range of the friction fact rows, refuses a range under 14 days, and otherwise writes the final kinds, endings and that range into `ledger/debrief_form.json` and moves `form_version` from `1-provisional` to `1`. A test of the command uses made-up rows.

## Tasks

1. **The form and the earning rule** (`ledger/debrief_form.json`, `ledger/debrief.py`): load, `earns`, `parse_output`, `write_debrief`, `finalise_form`. Tests for every scenario of the ticket.
2. **The trimmed input** (`ledger/debrief_sources.py`): handles, budget, long-session fallback, screening, defused markers. Tests with made-up transcripts.
3. **One call for both** (`ledger/summary.py`): pending query, the decision between combined, debrief-only and summary-only, the cost row, the rejected-output path. Existing summary tests updated for the new counts.
4. **Docs and proof**: `ledger/README.md`, `docs/design/data-model.md`, `docs/decisions.md`, `jobs.yaml` description, `docs/proof/2026-11-17/JP-113/README.md`.

## Out of scope and what stays owed

The weekly review, showing a debrief to Josh, and the working agent writing its own debrief are not part of this ticket. Owed, on the laptop, no sooner than two weeks of real fact rows: read them, edit the kind lists in `ledger/codes.json` if what actually happens differs, and run `finalise-form`. Until then every stored debrief says `1-provisional`.
