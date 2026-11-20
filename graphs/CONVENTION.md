# Graph convention

## Contents

- [What a graph is](#what-a-graph-is)
- [Folder layout](#folder-layout)
- [The portable parts](#the-portable-parts)
- [The graph file](#the-graph-file)
- [The header](#the-header)
- [Scoring a run](#scoring-a-run)
- [Steps](#steps)
- [Wait steps](#wait-steps)
- [How a graph runs](#how-a-graph-runs)
- [The walker](#the-walker)
- [The rules](#the-rules)
- [The run cap](#the-run-cap)
- [The checker](#the-checker)
- [Changing this convention](#changing-this-convention)

Convention version 1. Ticket JP-101. Requirements: `docs/vision-and-roadmap.md`, "Agent graphs".

## What a graph is

A graph is a workflow that carries one ticket through named steps. Each step is done by an agent, a script or Josh. Graphs are stored as portable parts in plain files, so the tool that runs them (Agent Manager today, maybe Claude Code desktop or a Paseo plugin later) can change without rewriting them. Nothing in `graphs/` outside `graphs/bindings/` may depend on one tool.

The checker, `graphs/tools/check_graph.py`, refuses a graph file that breaks this convention. A rule that the checker can enforce is enforced there, not asked for in prose.

## Folder layout

```text
graphs/
  CONVENTION.md          this file
  tiers.yaml             the three tiers, mapped to a model and an effort, plus each tier's run cap (the only place a model is named)
  flows/<graph>.yaml     one neutral graph file per graph; the file name is the graph's id
  roles/<role>/          role.yaml and instructions.md
  agents/<agent>/        agent.yaml and instructions.md
  gates/<gate>.py|.sh    gate scripts
  contracts/<name>.md    the formats passed between steps
  bindings/<tool>/       everything specific to one runner (Agent Manager first); never read by the checker
  intake/                the command that starts a ticket creation run (submit.py)
  runner/                the graph runner: watches Jira, starts runs and Agent Manager sessions
  tools/                 the checker, the walker (walker.py, walker_lib/) and compile_graphs.py
  compiled/              the JSON copy of each graph the walker reads (built by compile_graphs.py)
  tests/                 the checker's tests and sample graphs
```

Names of graphs, roles, agents, gates and contracts are lower case words joined by hyphens (`code-reviewer`). Step ids and input names use underscores (`approve_spec`, `ticket_key`).

## The portable parts

### Roles

A role is a job in a graph, such as designer, builder or code reviewer. It lives in `roles/<role>/`:

- `role.yaml`:
  - `title`: a short name for people.
  - `may_change`: `true` if the role may change files, tickets or anything else; `false` if it only reads and judges.
  - `tier`: `cheap`, `mid` or `gate`, the cheapest tier that can do the job.
  - `reviewer` (optional, default `false`): `true` for a role whose output is a list of defects.
- `instructions.md`: what the role does, in plain words. Not empty.

### Agents

An agent is a specific worker Josh has designed for a kind of work, such as a builder who knows PIMS. It fills one role and adds to that role's instructions. It lives in `agents/<agent>/`:

- `agent.yaml`: `title`, and `fills`, the role it fills.
- `instructions.md`: what this agent knows or does beyond the role. Not empty.

A step names a role. It can also name the agent that fills it, directly (`agent: pims-builder`) or by a rule on a graph input (see [Steps](#steps)).

### Gate scripts

A gate script is a check with no model in it. It lives in `gates/<gate>.py` or `gates/<gate>.sh`. It reads its inputs from environment variables named `GRAPH_INPUT_<NAME>` (the input name in upper case), and prints one line of JSON on standard output:

```json
{"outcome": "pass", "outputs": {"phase_id": "p2"}, "summary": "one line for the ledger"}
```

`outcome` is one of the outcomes the step declares. `outputs` and `summary` are optional. A gate script may move a Jira ticket or set a label; nothing else may.

### Contracts

A contract is a format passed between steps. Each is described in `contracts/<name>.md`; `contracts/README.md` lists them all. A step output names its contract (`contract: spec`), so a reader can find its format.

### Tiers

There are three tiers, from cheapest to dearest: `cheap` (fully specified, mechanical work), `mid` (intake, design, moderate ambiguity) and `gate` (a judgment that needs the most foresight). `tiers.yaml` maps each tier to a list of models: the first is used, the rest are fallbacks in order. An entry is always `{model: <name>, effort: low|medium|high}`: a bare model name is not allowed, fallbacks included, so every tier states how hard its model thinks as well as which model it is. *The checker refuses an entry with no effort, naming it (for example `tiers.mid[0]`).* A step still chooses its model only by role and tier, never by how hard the task is. Graph files, roles and agents name tiers, never models. `tiers.yaml` also carries each tier's `max_runs`; see [The run cap](#the-run-cap).

## The graph file

One YAML file per graph, `flows/<graph>.yaml`. Its top-level keys are exactly these:

| Key | Required | What it holds |
| --- | --- | --- |
| `convention` | yes | `1`, the version of this convention |
| `graph` | yes | the graph's id, equal to the file name without `.yaml` |
| `title` | yes | a short name for people |
| `description` | yes | one paragraph: what goes in and what comes out |
| `header` | yes | see [The header](#the-header) |
| `inputs` | no | the values a run starts with |
| `outputs` | no | the values a run ends with |
| `steps` | yes | the list of steps |

`inputs` and `outputs` map a name to `{type, required, default, description}`. `type` is `string`, `number`, `boolean` or `list`; only `type` is required.

Any other key, at any depth, is refused. A key that belongs to one runner (`model`, `mode`, `isolation`, `manager`, `providers`, `timeout` and the like) is refused with a message saying it belongs in `bindings/<tool>/`.

## The header

Every graph file carries a `header` with all seven fields:

| Field | What it says |
| --- | --- |
| `jira` | The Jira status each stretch of the graph maps to: a list of `{status, steps}`. Every step is in exactly one stretch. Only a gate script moves the ticket. |
| `entry_gate` | The gate script that admits a ticket (for most graphs, `ready`). |
| `exit_gate` | The gate script that closes a run (for most graphs, `no-loose-ends`). |
| `asks_josh` | Every step where Josh is asked: exactly the graph's `ask` steps. |
| `ledger` | What the walker writes to the ledger for each step, from: `run`, `step`, `outcome`, `loop_count`, `session`, `tier`, `ticket`, `started_at`, `ended_at`, `graph_version`, `model`. |
| `access` | For every step, what it touches: `read` (only reads), `josh` (writes something of Josh's, such as his repository or his JP ticket) or `shared` (writes something other people use). |
| `end_states` | Every way a run can end, scored as `success`, `neutral` or `needs-josh`. See [Scoring a run](#scoring-a-run). |

## Scoring a run

Josh wants to judge any graph the same way, on whether it works (effectiveness) and what it costs (efficiency) (16 November 2026, JP-140). Three things make that possible: two ledger fields, and a score for each way a run can end.

**`graph_version`** is the commit of the graph file the run used: the last commit that changed `graphs/flows/<graph>.yaml`. Two runs with the same value ran the same graph file, so a change to a graph can be compared before and after. It does not cover a change to a role, an agent or a gate script the graph names; those are separate files and a separate version if that ever matters.

**`model`** is the model that actually answered the step. It is not the tier's first choice: when a fallback answers, the fallback is named, which is what makes cost per step computable. A gate or ask step has no model and leaves it empty. The run cap still counts by tier (see [The run cap](#the-run-cap)); `model` changes nothing there.

**`end_states`** names every way a run of this graph can end, and scores each one. Every graph uses the same three scores:

| Score | Meaning |
| --- | --- |
| `success` | The run did what the graph is for. |
| `neutral` | The run ended with nothing wrong and nothing gained, such as a ticket Josh dropped or sent back. |
| `needs-josh` | The run could not finish without him, or ended in a state he must look at. |

The ends of a graph are:

- `finished`: the run ran out of steps and passed the exit gate. Every graph has it.
- `<step>.<outcome>`: one for each outcome whose `on` is `end`, such as `decide_review.stop`.

```yaml
end_states:
  finished: success
  approve_spec.drop: neutral
  decide_review.stop: needs-josh
```

*The checker refuses a graph with no `end_states`, an end that is not named (it reports it as unclassified), a name that is not an end of the graph, and a score other than the three above.* A loop (`goto`) and an outcome that only moves on are not ends. A run whose exit gate refuses never finished, so it is not `finished`. It ends as `exit_refused`, a name reserved for every graph: it always scores `needs-josh`, because the loose end is for Josh to close, and it is never written in `end_states` (the checker refuses it there).

Exit gates are scripts, and a graph file does not list their outcomes, so the checker cannot see more than one way for the exit gate to pass. A graph that needs two scores for a finished run ends them in two steps, each with an `on: end` outcome, before the exit gate.

The walker (JP-114) writes the end a run reached, as one of these names or `exit_refused`, and the data model (JP-99) stores it. The score for a name comes from the header of the graph version the run used, so a later change to a score does not rewrite the old runs. Which measures are built from these fields, and how they are shown, is JP-130.

## Steps

Every step has an `id` and exactly one of `role`, `gate`, `ask` or `wait`.

| Key | On | What it holds |
| --- | --- | --- |
| `id` | all | unique within the graph |
| `role` | role step | the role's name |
| `agent` | role step, optional | an agent's name, or a rule `{by: <graph input>, map: {<value>: <agent>}, default: <agent>}`. Every agent named must fill the step's role. |
| `tier` | role step, optional | a tier lower than the role's own, when this use of the role is simpler. Never higher. |
| `brief` | role step, optional | one or two sentences this step adds to the role's instructions. `{{ inputs.<name> }}` stands for a graph input's value, and must name one (the same holds in an ask's `question`). |
| `gate` | gate step | the gate script's name |
| `effects` | gate step, optional | what the script changes outside the run: `move_ticket`, `set_label`. A step with effects is never `read` in the header's `access`. |
| `wait` | wait step | the name of a gate script that only reads. It answers `pending` while the run must wait, or one of the step's `outcomes` when it can go on. See [Wait steps](#wait-steps). |
| `ask` | ask step | `{question, choices, approves, approves_on, on_limit_only, split}`. `choices` is a list of answers, which are the step's outcomes. `approves` (optional) lists the steps this ask approves, and then `approves_on` lists the choices that mean yes: some of the choices, never all, so Josh can always say no. `on_limit_only: true` marks an ask that runs only when a loop reaches its limit; it takes no `needs` or `when`, and at least one loop's `at_limit` must name it. `split` (optional) lists the details that split this ask into categories for decision memory; see below. |
| `needs` | all, optional | steps that must finish first |
| `when` | all, optional | `{step: <id>, outcome: <outcome or list>}`: run only if that step ended with that outcome; otherwise skip |
| `inputs` | role, gate and wait steps, optional | a list of names the step reads: graph inputs, or outputs of steps it `needs` (directly or further up) |
| `outputs` | role, gate and wait steps, optional | name to `{type, description, contract}` |
| `outcomes` | role, gate and wait steps | the outcomes the step can end with; an ask step's outcomes are its `choices` |
| `on` | all, optional | what an outcome does, when it does more than move on: `end`, or `{goto: <step>, max_loops: <n>, at_limit: <ask step>}` |

**Categories of question (`split`).** Every answer Josh gives is saved, and decision memory moves a whole category of question through its three stages (JP-106, question 4, option C). By default an ask step is one category, `<graph>/<step>`. An ask whose answers differ by detail lists those details in `split`, and each value then makes its own category: `ticket-creation/approve;system=josh-360;shape=single` is a different category from `ticket-creation/approve;system=josh-360;shape=epic_with_tickets`, so a yes to a single ticket is never offered as precedent for an epic with children. The walker builds the category from the names in the order listed, from the run's values at the time of asking; a value is a short code (lowercase letters, digits, `.`, `_` and `-`), and an ask whose value is not one is asked with no precedent. Precedent is looked up by category, system and work type together, never wider, and the ledger refuses a precedent from another category (`docs/design/data-model.md`, "Decisions"). *The checker refuses a `split` that is not a list of distinct names, or that names something other than a graph input or an output of a step above the ask.*

### Wait steps

A graph sometimes has to wait for something outside it, such as a review that takes hours or a merge that takes days. A gate script must answer at once, an ask is for Josh, and a role step would keep a model session open, so a wait is a fourth kind (JP-115). It is additive: no graph file becomes invalid, and the convention stays at version 1.

- A `wait` names a script in `gates/` and lists `outcomes` like a gate. It may have `needs`, `when`, `inputs`, `outputs` and `on`.
- The script runs like any gate and answers at once. `{"outcome": "pending"}` means "not yet": the walker records nothing, counts no loop, prints `waiting`, and the runner calls `next` again later. Any declared outcome ends the wait, as a gate's does.
- No session is open and a wait never changes anything outside the run: its access is `read` and it takes no `effects`. A wait's only writes are its own notes in the run's work folder (a watch's check log, for one), which are run state in the way the walker's `run.json` is. `pending` is reserved, so a wait never declares it.
- A wait that can last long names its own deadline in its script and answers a declared outcome when it passes. A wait is not a gate for rule 5: a reviewer role still needs a `gate` step.

## How a graph runs

The walker (`graphs/tools/walker.py`, JP-114; see [The walker](#the-walker)) holds this logic; a runner only starts the step the walker names.

1. The entry gate runs first. A run starts only if it passes.
2. A step is ready when every step in its `needs` has finished or been skipped, and its `when` matches. A step whose `when` does not match is skipped.
3. When a step ends, its outcome is looked up in `on`. `end` ends the run. `goto` sends the run back to that step, which runs again with every step that depends on it, and counts one loop. When the count reaches `max_loops`, the run goes to the `at_limit` ask step instead, so Josh decides. The run cap (rule 8) is a second limit, counted per role step across every loop. No entry means the run moves on. An `on_limit_only` ask step never runs in the normal flow.
4. When no step is left, the exit gate runs. The run is finished only if it passes.
5. The walker writes the header's `ledger` fields for every step, and the end the run reached (see [Scoring a run](#scoring-a-run)).

## The rules

These are the habits from Josh's drafted pipeline. Each line says how it is held.

1. **Scripts decide and models judge.** A role returns an outcome; the graph and gate scripts decide what happens next. A role never names the next step. *Held by the file's shape: `on` and `when` live in the graph, not in roles.*
2. **Only scripts set labels and move tickets.** *The checker refuses `effects` on a role or ask step, and every Jira status is reached through the header's `jira` map, which only a gate script applies.*
3. **Each step uses the cheapest tier that can do it.** *The checker refuses a step tier above its role's tier, and the `gate` tier on a role that may change things: the dearest tier judges, it never builds.*
4. **Every loop has a limit that ends at a human.** *The checker refuses a `goto` without `max_loops`, or whose `at_limit` is not an ask step.*
5. **A reviewer can only cite the plan.** *The checker refuses a step whose role is a reviewer unless a gate step directly `needs` it: that gate deletes any defect that does not quote the spec.*
6. **A shared write runs only on Josh's yes.** *The checker refuses a `shared` step unless an ask step that `approves` it comes before it through `needs`, and the shared step's `when` names that ask with only `approves_on` choices. The approving ask takes no `when` and is never `on_limit_only`, because a skipped approval is not a yes.*
7. **A role that only reads only reads.** *The checker refuses a step whose access is `josh` or `shared` when its role has `may_change: false`.*
8. **A role step runs no more often than its tier allows.** *`tiers.yaml` gives every tier a `max_runs`, and the checker refuses a `goto` whose `max_loops` + 1 passes the cap of a role step it runs again. Details in [The run cap](#the-run-cap).*

## The run cap

Josh wants no unnecessary loops on the costlier models (16 November 2026, JP-139). `max_loops` limits one `goto`, but several loops can send the run back to the same step, so a second limit counts the runs of the step itself.

**The values.** `tiers.yaml` has a `max_runs` mapping beside `tiers`, one whole number of 1 or more for each tier: `cheap` 5, `mid` 3, `gate` 2 (Haiku, Sonnet and Opus as the tiers stand today). It is the most times one role step runs in one run of a graph, the first run included.

**The count is by tier, not by the model that answered.** A step's tier is its own `tier` when it names one, otherwise its role's. When the first model in the tier is out of tokens and a fallback answers, the run still counts against the tier's cap, not a cap of its own. Nothing about the model that answered moves the count.

**What the checker holds.** A `goto` whose `max_loops` is *n* can run each role step it sends the run back through *n* + 1 times. The checker refuses the graph when that is more than the step's tier cap, naming the loop, the step and the tier:

```text
loop check_review -> build (outcome 'rework') would run step 'review' 3 times (max_loops 2 + 1) against a gate cap of 2
```

The steps a loop runs again are the target and every step that depends on it (`needs`, directly or further down), except the steps that depend on the loop's own step, because those cannot have run yet. A step that is skipped by its `when` is still counted, so for a single loop the check is an upper bound. The checker also refuses a `tiers.yaml` where a tier has no `max_runs`, where one is not a whole number of 1 or more, or where `max_runs` names something that is not a tier. A `goto` that reruns any role step of the `gate` tier can have a `max_loops` of 1 at most, because the gate cap is 2. (The `gate` tier is the Opus tier; script gates, the `gate` step kind, have no cap.)

**What the walker holds** (JP-114 built this; this section is its rule):

1. Count every run of every role step, whichever loop sent the run back to it, in one counter for each step in one run of the graph. The first run counts as run 1.
2. Before starting a role step again, compare the count with the cap of the step's tier. When the next run would pass the cap, do not start it: send the run to that loop's `at_limit` ask step.
3. Each yes from Josh at that ask allows exactly one more run of that step, no more. The extra run is counted like any other, so the next time the cap is reached Josh is asked again. A *yes* is a choice whose `on` is a `goto`, taken at an ask the run was sent to by a limit; that `goto` is Josh's own decision, so its own `max_loops` is not enforced by the walker (the checker still requires it), and it allows one extra run of each role step it sends the run back through that is at its cap. Any other choice moves on or ends, and no extra run is allowed.
4. Record the tier, and whether the run was one Josh allowed, in the ledger for the step (`tier` is already a ledger field).

The checker cannot add up loops that share a step, because which loops fire depends on the outcomes of the run. That sum is the walker's job; the checker only makes sure no single loop is written to break the cap.

**Only a model that ran counts** (JP-183, Josh, 20 November 2026). Retries and runs of the cap are spent only on failures that could change. Every failure is sorted into one of three kinds by one shared table, `laptop/failure_kinds.py`, which the runner, the walker and the laptop job runner all use:

| Kind | What it is | Examples (reason codes) | What happens |
| --- | --- | --- | --- |
| `needs-fix` | Won't fix itself | `bad-model`, `bad-effort`, `no-cli`, `no-folder`, a job's `needs-fix` exit (78) or an import error | The run stops at once, with no retries, and one stop notice names the cause and the fix. The attempt is not abandoned, so it uses no run. |
| `may-clear` | Might fix itself | `not-running`, `timeout`, `rate-limited`, `network`, `group`, an unexplained `refused`, a session that `never-started` or was `gone-before-start` (never linked to its run) | Tried again after growing gaps (`spawn_gaps_seconds`), never counted against the cap. When the tries (`spawn_tries`) run out the run is stuck, not abandoned. |
| `ran` | The model ran and the step failed | `bad-result`, `time-cap`, `session-gone`, `rested-without-result` | The attempt is abandoned and counts as one run, as before. |

A reason the table does not know is `may-clear`, so nothing is stopped for good by guesswork. A run stopped for `needs-fix` or `may-clear` goes on from the same step, with the same attempt and its count unchanged, in either of two ways: on its own on the next pass once what the failure depended on has changed (the stop keeps a fingerprint of the binding's settings and commands, the run's compiled graph and the laptop copy's commit), or with `runner.py resume --run <id>`. Neither needs an `allow`.

A gate that stops a run is sorted the same way (JP-188). A gate that exited 1 or timed out may be saying "not yet" (the exit gate `no-loose-ends` stops every run until the recorder has caught up with the last session), so the runner tries the gate again on the same growing gaps, up to `spawn_tries`, before the stop is told about. A gate that printed an outcome its step does not declare, printed no outcome, is missing or failed with any other exit needs a fix, and its stop is told about at once.

## The walker

`graphs/tools/walker.py` (JP-114) is the one script that holds the logic above. Design and decisions: `docs/superpowers/specs/2026-11-17-walker-design.md`. It runs on the laptop's Python 3.9 with the standard library only, so it reads the JSON copy of a graph in `graphs/compiled/<graph>.json`, never the YAML.

- **The JSON copy.** `python3 graphs/tools/compile_graphs.py` (cloud, needs PyYAML) runs the checker and writes the copy for each graph that passes, with the SHA-256 of every source file. `scripts/check.py` fails when a copy is missing or stale. The walker refuses a graph with no copy, a copy whose sources changed, or (where PyYAML is installed) a graph the checker rejects. *A change to a graph file, a tier, or a role or agent it names needs `compile_graphs.py` run in the same pull request.*
- **Commands.** `start`, `next`, `record`, `answer`, `abandon`, `allow`, `retry`, `status`, `stop`. `stop --run --step --kind --code --reason [--fingerprint]` is the runner's (JP-183): it stops a run at its open role step for a failure that started no model, leaving the attempt open so no run of the cap is used; `retry` lifts it. `next` prints `run` (a role step for the binding to start), `parked` (a question is waiting for Josh), `waiting` (a wait step's script answered `pending`; call `next` again later), `done` (the end and its score) or `stopped`. It runs gate steps itself, and a wait step's script too: a wait writes its ledger row only when it ends, as step kind `gate`, and `status` shows the one a run is waiting at. Calling it again prints the same answer until something changes.
- **State.** The ledger holds every step (`graph_runs`, `step_runs`, `step_results`, `asks`, `decisions`, `run_ends`, `run_files`); the walker replays them to find its place. The run's input values and step outputs are in `$JOSH360_RUNS/<run id>/run.json` (default `~/.josh-360/runs/`), outside the repository.
- **The work folder.** `$JOSH360_RUNS/<run id>/work/` exists from the start and holds a run's working files, never a worktree. The walker appends every answered ask, and every step output named `answer`, to `work/answers.md`; at the end of a run it saves `work/hardening.md` and every `work/feedback/*.md` beside the files its steps named. When two steps give an output the same name, the step that finished last wins.
- **How a role session reports.** The `run` answer carries `result_file`, and (JP-117) `graph`, `ticket` (or null), `access` (the step's `read`, `josh` or `shared`), `work_dir` and `phi`, so a binding can build a prompt and a guard from the answer alone. The session writes `{"outcome": "...", "outputs": {...}}` there, and the binding calls `record --result-file`. The outcome must be one the step declares and every output one it declares. It may also carry `follow_ups` (JP-175, `graphs/contracts/follow-up.md`): work found outside the ticket. The walker saves each one in the run folder and runs the fixed gates `file-follow-ups` (starts a ticket-creation run through intake) and `follow-up-wait` (holds the run as `waiting` while a follow-up that blocks the ticket is open, and lets it go when the new ticket is Done or Cancelled or the follow-up is dropped). These are not graph steps: they write no ledger row and count no loop.
- **What a gate script is given.** `GRAPH_INPUT_<NAME>` for each input the step lists (a list as JSON), `GRAPH_INPUT_TARGET_STATUS` (the Jira status of the step's stretch), `JOSH360_TICKET_KEY`, `JOSH360_GRAPH` (the graph's id, for the entry gate only), `JOSH360_RUN_ID`, `JOSH360_RUNS`, and the Jira credentials (`JOSH360_JIRA_EMAIL`, `JOSH360_JIRA_TOKEN`), found the way every Jira reader on the laptop finds them (`ledger/jira_read.py`): the email from the environment, else `~/.josh-360/state/jira-email`; the token from the environment, else the keychain item `jira-claude-api-key` (JP-171). `doctor.py --only graphs` says whether a gate would get both (`graphs.gate-jira`). Role sessions never get the credentials. A gate that fails (no outcome, an undeclared outcome, a non-zero exit, a timeout) stops the run; the walker never retries it.
- **Jira.** The walker moves a ticket to the status of the stretch the next step is in by calling the `move-ticket` gate script. A gate step with `effects: move_ticket` moves the ticket itself and is passed the target. It sets the Jira flag when a question is parked and clears it on the answer (`set-flag`), and posts a typed answer (`post-comment`) after the patient-data screen for outside writes. A failed Jira effect is a warning on the output, never a stop.
- **Asking Josh.** A parked ask is a record in action-triage's Needs you store (`questions/`, `runner: headless`); no session waits. The ask's text is its `question` plus a step output named `card` from a step above it, when there is one. The category is `<graph>/<step>` plus `;<name>=<value>` for each name in `split`, and the answer is saved as a decision.
- **Not the walker's job.** Starting sessions and deciding when a run starts (the runner, JP-117), and the content of any role.

## The checker

```bash
python3 graphs/tools/check_graph.py                             # every graph in graphs/flows/
python3 graphs/tools/check_graph.py graphs/flows/my-graph.yaml   # one file
python3 graphs/tools/check_graph.py --root <dir> <file>         # another parts folder (the tests use this)
python3 graphs/tools/compile_graphs.py [--check]                 # the JSON copies the walker reads (see The walker)
```

It checks `tiers.yaml` (models, efforts and run caps), every role and agent, and each graph file. A wait step must name a gate script, have access `read`, take no `effects` and not declare `pending`. It prints one line per problem, naming the file and where in it (a step id, a loop, a key), and exits 0 when there are none, 1 when there are, and 2 when it cannot run (a missing folder, or PyYAML not installed). A YAML key written twice in one mapping is refused, and `on`, `off`, `yes` and `no` are read as plain words, not as true or false. It needs PyYAML (`pip install -r requirements.txt`). `python3 scripts/check.py`, the repository's suite, runs it and its tests (`graphs/tests/`). The sample graphs there, one that passes and one per broken rule, are the quickest way to see the convention in use.

## Changing this convention

A change to this file changes the checker and its tests in the same pull request. The `wait` step (JP-115) is an additive change: the convention stays at version 1. A change that would make an existing graph file invalid raises `convention` to the next number and says how to move a file across.
