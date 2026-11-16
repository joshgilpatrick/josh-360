# Graph convention

## Contents

- [What a graph is](#what-a-graph-is)
- [Folder layout](#folder-layout)
- [The portable parts](#the-portable-parts)
- [The graph file](#the-graph-file)
- [The header](#the-header)
- [Steps](#steps)
- [How a graph runs](#how-a-graph-runs)
- [The rules](#the-rules)
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
  tiers.yaml             the three tiers, mapped to models (the only place a model is named)
  flows/<graph>.yaml     one neutral graph file per graph; the file name is the graph's id
  roles/<role>/          role.yaml and instructions.md
  agents/<agent>/        agent.yaml and instructions.md
  gates/<gate>.py|.sh    gate scripts
  contracts/<name>.md    the formats passed between steps
  bindings/<tool>/       everything specific to one runner (Agent Manager first); never read by the checker
  tools/                 the checker now, the walker later
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

A contract is a format passed between steps. Each is described in `contracts/<name>.md`. The first four are the intake record, the spec, the evidence file and the feedback files. A step output names its contract (`contract: spec`), so a reader can find its format.

### Tiers

There are three tiers, from cheapest to dearest: `cheap` (fully specified, mechanical work), `mid` (intake, design, moderate ambiguity) and `gate` (a judgment that needs the most foresight). `tiers.yaml` maps each tier to a list of models: the first is used, the rest are fallbacks in order. An entry is a model name, or `{model: <name>, effort: low|medium|high}`. Graph files, roles and agents name tiers, never models.

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

Every graph file carries a `header` with all six fields:

| Field | What it says |
| --- | --- |
| `jira` | The Jira status each stretch of the graph maps to: a list of `{status, steps}`. Every step is in exactly one stretch. Only a gate script moves the ticket. |
| `entry_gate` | The gate script that admits a ticket (for most graphs, `ready`). |
| `exit_gate` | The gate script that closes a run (for most graphs, `no-loose-ends`). |
| `asks_josh` | Every step where Josh is asked: exactly the graph's `ask` steps. |
| `ledger` | What the walker writes to the ledger for each step, from: `run`, `step`, `outcome`, `loop_count`, `session`, `tier`, `ticket`, `started_at`, `ended_at`. |
| `access` | For every step, what it touches: `read` (only reads), `josh` (writes something of Josh's, such as his repository or his JP ticket) or `shared` (writes something other people use). |

## Steps

Every step has an `id` and exactly one of `role`, `gate` or `ask`.

| Key | On | What it holds |
| --- | --- | --- |
| `id` | all | unique within the graph |
| `role` | role step | the role's name |
| `agent` | role step, optional | an agent's name, or a rule `{by: <graph input>, map: {<value>: <agent>}, default: <agent>}`. Every agent named must fill the step's role. |
| `tier` | role step, optional | a tier lower than the role's own, when this use of the role is simpler. Never higher. |
| `brief` | role step, optional | one or two sentences this step adds to the role's instructions. `{{ inputs.<name> }}` stands for a graph input's value, and must name one (the same holds in an ask's `question`). |
| `gate` | gate step | the gate script's name |
| `effects` | gate step, optional | what the script changes outside the run: `move_ticket`, `set_label`. A step with effects is never `read` in the header's `access`. |
| `ask` | ask step | `{question, choices, approves, approves_on, on_limit_only}`. `choices` is a list of answers, which are the step's outcomes. `approves` (optional) lists the steps this ask approves, and then `approves_on` lists the choices that mean yes: some of the choices, never all, so Josh can always say no. `on_limit_only: true` marks an ask that runs only when a loop reaches its limit; it takes no `needs` or `when`, and at least one loop's `at_limit` must name it. |
| `needs` | all, optional | steps that must finish first |
| `when` | all, optional | `{step: <id>, outcome: <outcome or list>}`: run only if that step ended with that outcome; otherwise skip |
| `inputs` | role and gate steps, optional | a list of names the step reads: graph inputs, or outputs of steps it `needs` (directly or further up) |
| `outputs` | role and gate steps, optional | name to `{type, description, contract}` |
| `outcomes` | role and gate steps | the outcomes the step can end with; an ask step's outcomes are its `choices` |
| `on` | all, optional | what an outcome does, when it does more than move on: `end`, or `{goto: <step>, max_loops: <n>, at_limit: <ask step>}` |

## How a graph runs

The walker (a later ticket) holds this logic; a runner only starts the step the walker names.

1. The entry gate runs first. A run starts only if it passes.
2. A step is ready when every step in its `needs` has finished or been skipped, and its `when` matches. A step whose `when` does not match is skipped.
3. When a step ends, its outcome is looked up in `on`. `end` ends the run. `goto` sends the run back to that step, which runs again with every step that depends on it, and counts one loop. When the count reaches `max_loops`, the run goes to the `at_limit` ask step instead, so Josh decides. No entry means the run moves on. An `on_limit_only` ask step never runs in the normal flow.
4. When no step is left, the exit gate runs. The run is finished only if it passes.
5. The walker writes the header's `ledger` fields for every step.

## The rules

These are the habits from Josh's drafted pipeline. Each line says how it is held.

1. **Scripts decide and models judge.** A role returns an outcome; the graph and gate scripts decide what happens next. A role never names the next step. *Held by the file's shape: `on` and `when` live in the graph, not in roles.*
2. **Only scripts set labels and move tickets.** *The checker refuses `effects` on a role or ask step, and every Jira status is reached through the header's `jira` map, which only a gate script applies.*
3. **Each step uses the cheapest tier that can do it.** *The checker refuses a step tier above its role's tier, and the `gate` tier on a role that may change things: the dearest tier judges, it never builds.*
4. **Every loop has a limit that ends at a human.** *The checker refuses a `goto` without `max_loops`, or whose `at_limit` is not an ask step.*
5. **A reviewer can only cite the plan.** *The checker refuses a step whose role is a reviewer unless a gate step directly `needs` it: that gate deletes any defect that does not quote the spec.*
6. **A shared write runs only on Josh's yes.** *The checker refuses a `shared` step unless an ask step that `approves` it comes before it through `needs`, and the shared step's `when` names that ask with only `approves_on` choices. The approving ask takes no `when` and is never `on_limit_only`, because a skipped approval is not a yes.*
7. **A role that only reads only reads.** *The checker refuses a step whose access is `josh` or `shared` when its role has `may_change: false`.*

## The checker

```bash
python3 graphs/tools/check_graph.py                             # every graph in graphs/flows/
python3 graphs/tools/check_graph.py graphs/flows/my-graph.yaml   # one file
python3 graphs/tools/check_graph.py --root <dir> <file>         # another parts folder (the tests use this)
```

It checks `tiers.yaml`, every role and agent, and each graph file. It prints one line per problem, naming the file and where in it (a step id, a loop, a key), and exits 0 when there are none, 1 when there are, and 2 when it cannot run (a missing folder, or PyYAML not installed). A YAML key written twice in one mapping is refused, and `on`, `off`, `yes` and `no` are read as plain words, not as true or false. It needs PyYAML (`pip install -r graphs/requirements.txt`). `python3 scripts/check.py`, the repository's suite, runs it and its tests (`graphs/tests/`). The sample graphs there, one that passes and one per broken rule, are the quickest way to see the convention in use.

## Changing this convention

A change to this file changes the checker and its tests in the same pull request. A change that would make an existing graph file invalid raises `convention` to the next number and says how to move a file across.
