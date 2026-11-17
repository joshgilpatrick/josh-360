# The walker: design

## Contents

- [What it is](#what-it-is)
- [The checklist from the JP-146 review (B1)](#the-checklist-from-the-jp-146-review-b1)
- [The commands](#the-commands)
- [How a run is kept](#how-a-run-is-kept)
- [How the next step is worked out](#how-the-next-step-is-worked-out)
- [Loops and the run cap](#loops-and-the-run-cap)
- [Asking Josh](#asking-josh)
- [Gate scripts and Jira](#gate-scripts-and-jira)
- [The JSON copy of a graph (B2)](#the-json-copy-of-a-graph-b2)
- [The shared gate library (C2)](#the-shared-gate-library-c2)
- [Scenarios](#scenarios)
- [Out of scope](#out-of-scope)

Ticket JP-114. Requirements: `docs/vision-and-roadmap.md` ("The walker"), `graphs/CONVENTION.md` ("How a graph runs", "The run cap"), the JP-146 review (findings B1, B2, C2), `docs/design/data-model.md`. Choices that could be taken either way are in `docs/decisions.md` under JP-114.

## What it is

One small script, `graphs/tools/walker.py`, holds the graph logic. Given a graph and the run so far, it says the next step. The tool that runs a graph (the Agent Manager binding, JP-117) only starts the session the walker names and tells the walker how it ended. The walker never starts a session, never decides when a run starts, and holds no role text.

It runs on the laptop, in the laptop's Python 3.9 with the standard library only. That is why it reads a JSON copy of each graph, not the YAML ([B2](#the-json-copy-of-a-graph-b2)).

Everything the walker knows about a run is in the ledger (`graph_runs`, `step_runs`, `step_results`, `asks`, `decisions`, `run_ends`, `run_files`) plus a small run folder (`$JOSH360_RUNS/<run id>/`, default `~/.josh-360/runs/`) holding the run's input values, the output values of its steps and the files saved at the end. Nothing is held in a live process or a session.

## The checklist from the JP-146 review (B1)

| Duty the designs gave the walker | Where it is built |
| --- | --- |
| Count runs per tier; each loop counter belongs to its own arrow | [Loops and the run cap](#loops-and-the-run-cap) |
| Record `graph_version`, `model` and the end of each run | `start` writes `graph_version` and `repo_commit`; `record --model` writes `model`; the end is a `run_ends` row scored from the graph's `end_states` |
| Start runs on triggers | **Not the walker.** The five triage triggers and the Ready-and-not-in-the-backlog rule belong to the runner (JP-117), which calls `start`. Decision recorded. |
| Set and clear the Jira flag; post a typed answer on the ticket | [Gate scripts and Jira](#gate-scripts-and-jira): the flag goes on when a question is parked and off when it is answered; a typed answer is posted after the patient-data screen |
| Show the approval card text | [Asking Josh](#asking-josh): a step output named `card` is the ask's detail |
| Pass `GRAPH_INPUT_TARGET_STATUS`, `JOSH360_RUNS`, `JOSH360_RUN_ID` to gate scripts | [Gate scripts and Jira](#gate-scripts-and-jira) |
| Know how an agent session reports its outcome | A session writes `$JOSH360_RESULT_FILE` (JSON `{"outcome", "outputs"}`); the binding calls `record --result-file` |
| Give gate scripts Jira credentials on the laptop | Gate scripts only, from `JOSH360_JIRA_EMAIL` / `JOSH360_JIRA_TOKEN`, else the keychain item `jira-claude-api-key` on macOS. Never a role session |
| "More than five runs in 24 hours" safety check | `start` refuses the sixth run on one ticket within 24 hours unless `--allow-repeat` |
| Apply the category split | [Asking Josh](#asking-josh) |

## The commands

All print one line of JSON. Exit 0 for any well-formed answer (including `parked`, `stopped` and `done`), 2 for a refusal or bad input.

| Command | What it does |
| --- | --- |
| `start --graph G (--ticket KEY \| --subject-kind K --subject-ref R) [--input k=v ...] [--runner R] [--phi] [--allow-repeat]` | Refuses a graph with no fresh JSON copy, unknown or missing inputs, and the sixth run in 24 hours. Runs the graph's entry gate; a gate that does not pass starts nothing and writes nothing. Otherwise creates the run and prints its id. |
| `next --run ID` | Prints what is next. Gate steps run inside this command and are never printed. Calling it twice prints the same answer. |
| `record --run ID --step S (--outcome O \| --result-file F) [--session ID] [--model M] [--tool claude-code]` | Ends the open role step. The outcome must be one the step declares. Adds the session's ledger row if it has none. |
| `answer --run ID --step S (--choice C \| --text T)` | Answers an open question when Needs you is not used (the same file Needs you writes). |
| `abandon --run ID` | Ends the open role step as `_abandoned` (its session died). The next `next` starts it again as another attempt. |
| `allow --run ID --step S` / `retry --run ID` | Josh's way past a stopped run: allow one more run of a step, or run a failed gate again. |
| `status --run ID` | The run's steps, loop counts and run counts, read from the ledger. |

`next` prints one of:

- `run`: a role step. Carries the step, role, agent (resolved), tier, the tier's models and efforts, the brief with inputs filled in, the input values, the Jira status of the step's stretch, the attempt number, whether Josh allowed this run past the cap, the folders of the role and the agent, and the path the session writes its result to.
- `parked`: a question is waiting for Josh. Carries the ask id and the Needs you record id. No session waits.
- `done`: the run ended. Carries the end name and its score.
- `stopped`: a gate failed, or the run cap was hit with no ask to reach. Carries the reason. It stays stopped until `retry` or `allow`.

## How a run is kept

The ledger is the truth about steps. `next` rebuilds the state by replaying the run's `step_runs` and `step_results` in order through the same pure function that works out the next step, so a killed process loses nothing (scenario: a run survives a closed terminal). If a row disagrees with what the graph says should have come next, the walker stops with "the ledger does not match the graph" and changes nothing.

The run folder holds what the ledger deliberately does not: input values (they can be text), step output values, `stopped`, the `allow` grants waiting to be used, the current Jira status and whether the flag is on. Losing it makes the run unresumable, which `next` says plainly; it never invents values.

A `start` writes the run row first and the `_entry` gate step second. The exit gate is recorded as the step `_exit`. Names that start with an underscore belong to the walker (`_entry`, `_exit`, and the outcomes `_abandoned` and `_error`).

## How the next step is worked out

1. If the run ended, `done`.
2. If a step was started and has no result, print it again (a role step), or look for the answer (an ask).
3. If a loop limit or the run cap sent the run to an ask, that ask is next.
4. Otherwise the first step in file order whose `needs` are all finished or skipped. A step whose `when` does not match is skipped. An `on_limit_only` ask is never reached this way.
5. With no step left, the exit gate runs. `pass` ends the run as `finished`; anything else ends it as `exit_refused`.
6. An outcome whose `on` is `end` ends the run as `<step>.<outcome>` at once, without the exit gate.

## Loops and the run cap

`graphs/CONVENTION.md` ("The run cap") already states the rules. The walker holds them as follows.

- **One counter for each arrow.** The key is the step the loop leaves and the step it goes to. It never resets during a run, even when an outer loop runs the same steps again.
- **A goto is checked when it fires**, not when the step starts. It is refused, and the run goes to the loop's `at_limit` ask, when its arrow is at `max_loops`, or when a role step it would run again has already run as often as its tier allows (`max_runs`, counted by tier, first run included, loops of every arrow added together). A step the loop would run again that its `when` later skips is still counted, which is the same upper bound the checker uses.
- **Josh's yes buys one run.** A `goto` taken from an `on_limit_only` ask is Josh's own yes. Its own `max_loops` is not enforced (Josh decides every extra round); instead each role step it runs again that is at its cap gets one extra run, recorded as `allowed_by_josh = 1` on that run. The next time the cap is reached he is asked again.
- **Any other answer moves on.** A choice with no `goto` or `end` leaves the step that hit the limit finished with its outcome, and the run carries on past it.
- **A run past the cap with no ask to reach** (an abandoned step that would run again over its cap) stops, and Josh uses `allow`.

`step_runs.attempt` is the step's run count in the run (every kind of step), `loop_count` is `attempt - 1`, and `tier` is the step's own or its role's.

## Asking Josh

When the next step is an ask, the walker parks the run in one transaction-sized sequence that can be repeated safely:

1. Works out the **category**: `<graph>/<step>`, then `;<name>=<value>` for each name in the ask's `split`, in order, from the run's values. A value that is not a short code (lower case letters, digits, `.`, `_`, `-`) leaves the ask with no precedent, as the convention says.
2. Looks up precedent in that category with the system and work type the run has (inputs named `system` and `work_type`), through the same query `ledger/ask.py precedent` uses, and records the lookup. At stage 2 or 3 the newest precedent is shown as a suggestion. Answering from memory without asking (stage 3) is the decision-memory tickets' (JP-116, JP-126), so the walker still asks.
3. Adds the `step_runs` row (kind `ask`) and the `asks` row.
4. Writes the Needs you record: `questions/walker-<run id>-<step>-<attempt>.json`, beside the action-triage state file, in the shape the app already reads (`runner: headless`, so it has no deadline and is never pruned while open). The question text is the ask's `question` with the `card` output appended when a step above produced one.
5. Sets the Jira flag on the ticket.
6. Prints `parked`.

`next` on a parked run reads the record. When it is `answered`, the answer is matched to a choice. A choice is the outcome. Typed text that matches no choice is the outcome `answered` when the ask declares that choice, and is otherwise refused (the run stays parked and says why). The walker then writes the `step_results` row and the `decisions` row (`answered`, or `confirmed-suggestion` / `changed-suggestion` against a suggestion), marks the record delivered, clears the flag, and carries on. A typed answer is also posted on the ticket, but only after the patient-data screen for outside writes (`external=True`) passes; if it does not, the answer is used and not posted, and the output says so.

## Gate scripts and Jira

A gate script runs as a subprocess (`.py` with the walker's interpreter, `.sh` with bash), with the run folder as its working directory and a time limit. Its environment is the walker's, plus:

- `GRAPH_INPUT_<NAME>` for each name in the step's `inputs` (a list is JSON);
- `GRAPH_INPUT_TARGET_STATUS`, the Jira status of the step's stretch, and `JOSH360_TICKET_KEY`;
- `JOSH360_RUNS` and `JOSH360_RUN_ID`;
- the Jira credentials above.

It prints one JSON line. An outcome the step does not declare, no JSON, a non-zero exit or a timeout is a failed gate: the walker records the outcome `_error` with the first line of the error, sets the flag, and stops the run. It never retries by itself (the convention's rule). The note stored with a result is the gate's own summary, dropped when it fails the patient-data screen or when the run is `phi`.

**The Jira status.** When the next step is in a different stretch from the one the walker last set, the walker calls the gate script `move-ticket` with `GRAPH_INPUT_TARGET_STATUS` and the ticket key. A gate step that has `effects: move_ticket` moves the ticket itself and is passed the target the same way, so the walker does not call it twice. A move that fails is a warning on the output and is tried again on the next `next`; it does not stop the run. Agents never move a ticket.

**The flag and the comment** go through two scripts with fixed command lines: `graphs/gates/set-flag.py --ticket KEY --on|--off` and `graphs/gates/post-comment.py --ticket KEY --body-file F`. They run on the shared Jira library `graphs/gates/lib/jira.py` (built by JP-121, [C2](#the-shared-gate-library-c2)) and exit 0 only when Jira confirms the change on read-back; any other result is a warning. The walker, not the script, runs the patient-data screen first.

**At the end of a run** the walker copies each step output that is a path to an existing file and whose contract is `spec`, `evidence`, `feedback` or `intake-record` (or any other contract: kind `output`) into `<run folder>/saved/`, with its hash, and adds `run_files` rows. The run folder is outside the repository, so the spec and the evidence outlive the worktree.

## The JSON copy of a graph (B2)

`graphs/tools/compile_graphs.py` (cloud, needs PyYAML) runs the checker, and for every graph that passes writes `graphs/compiled/<graph>.json`: the graph, the tier table with `max_runs`, the role and agent facts the walker needs, and the SHA-256 of every source file it came from. `scripts/check.py` runs it with `--check`, so CI fails when a copy is missing or stale. The walker reads only the JSON, and refuses to run a graph when a source file on disk no longer matches its recorded hash. Where PyYAML is present it also runs the checker live, so a graph the checker rejects is refused twice over (scenario: a rejected graph is not run).

`graph_version` is the last git commit that changed `graphs/flows/<graph>.yaml`; with no git, `sha256:` and the first 12 digits of the file's hash.

## The shared gate library (C2)

The three graph plans each create `graphs/gates/lib/gate_io.py` and a Jira helper differently. One page, so the builds do not collide:

| Piece | Agreed form |
| --- | --- |
| Read a gate's inputs | `gate_io.read_inputs(names, environ=None) -> dict` (reads `GRAPH_INPUT_<NAME>`; a name that is not set is `None`) and `gate_io.read_input(name)` for one |
| Print the result | `gate_io.finish(outcome, outputs=None, summary=None)` prints the one JSON line and exits 0 |
| Failure | `gate_io.fail(message)` writes to stderr and exits 1. Exit code 1 everywhere; the walker treats any non-zero exit the same |
| Jira helper | one file, `graphs/gates/lib/jira.py`, REST v3, built by whichever of JP-121, JP-122, JP-123 lands first; the others use it as it is |
| Jira credentials | `JOSH360_JIRA_EMAIL` and `JOSH360_JIRA_TOKEN`. The walker supplies them to gates, from the keychain item `jira-claude-api-key` when they are not set |
| Patient-data screen | `graphs/gates/lib/patient_data.py` `scan(text, source_text, flagged, external=False)` (JP-149); any text going to Jira or GitHub passes it with `external=True` |
| Ready checklist | `graphs/gates/lib/ready_checklist.py`, a dict of checks, created by JP-122 and read by JP-121 |

A gate script imports it as `from lib.gate_io import read_inputs, finish`; Python puts the script's own folder (`graphs/gates/`) on the path, so no setup is needed. JP-114 builds `gate_io` (small, and the walker's own tests need it) and records the rest here. The three plans are amended to match by their own build threads; this page is what they follow.

## Scenarios

```gherkin
Feature: The walker

  @auto
  Scenario: The next step follows the last outcome
    Given a graph, a run and the outcome of its last step
    When the walker is asked for the next step
    Then it prints the step the graph file gives for that outcome

  @auto
  Scenario: A run survives a closed terminal
    Given a run whose last step was recorded
    When the process is killed and the walker is asked again
    Then it prints the same next step, read from the ledger

  @auto
  Scenario: Park and resume
    Given a step whose outcome is a question for Josh
    When the walker parks the run
    Then the question is saved, it appears in the Needs you tab, and no session is left waiting
    And resuming with his answer continues from that step

  @auto
  Scenario: A loop limit ends at a human
    Given a loop that has reached its limit
    When the walker is asked for the next step
    Then the next step is a human

  @auto
  Scenario: A rejected graph is not run
    Given a graph the checker refuses
    When the walker is asked to start a run
    Then it refuses

  @auto
  Scenario: The run cap counts every loop together
    Given two loops that send the run back to the same role step
    When the step has run as often as its tier allows
    Then the next goto is sent to its at_limit ask
    And each yes from Josh buys exactly one more run, recorded as allowed by Josh
```

Each scenario is a test in `tests/test_walker*.py`, written first. The end of a run, the five-runs check, the patient-data screen on a typed answer and the JSON copy have tests of their own.

## Out of scope

Starting sessions and the Jira watch (JP-117); deciding when a run starts (JP-117, JP-124); the content of any role; the real `move-ticket`, `set-flag` and `post-comment` scripts (the graph build tickets); answering from memory at stage 3 (JP-116, JP-126); a unified question surface (a later phase).
