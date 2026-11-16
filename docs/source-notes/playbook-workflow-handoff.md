# Handoff: Tiered-Model Agent Workflow Design + Paseo Playbooks Research

_Context file for continuing a claude.ai conversation in Claude Code. Written 2026-11-10._

## 1. Goal

Design automated workflows where Claude Code sessions address Jira tickets. Different parts of a ticket need different model strengths:

- some parts need a very smart model (Opus-class)
- some parts are high-effort but mechanical and suit a cheaper model (Haiku-class)

The end product I want is a **workflow definition (YAML)** that tells an orchestrating agent how to run sub-agents with the right model for each step. I'm using the Paseo **Playbooks** plugin as a reference for how to structure that file.

## 2. What I need from Claude Code next

1. **Read the repo directly** (the claude.ai session could only see search snippets, not file contents): <https://github.com/lerenn/paseo-playbooks>
2. Report back how Playbooks does things, in the form: "Playbooks structures X like this" with real YAML examples from the repo. In particular:
   - the exact step schema (current format)
   - **how a step/role specifies its model or provider** (unconfirmed, see section 4)
   - how outcomes, `needs`, `goto` loops, conditional steps, gates, script steps, and sub-playbooks are expressed
   - what the Playbook Manager agent does vs. what the plugin enforces
   - how run state is kept and how failures/escalations are handled
3. Then help me draft a workflow YAML for my Jira-ticket pipeline (section 5), borrowing Playbooks conventions where they fit.

### Files to read first

- `OVERVIEW.md`
- `README.md` (including the "Known limits" section, added in PR #3)
- `docs/adrs/2026-11-02-design.md` (the original design)
- `docs/adrs/2026-11-06-group-step-kind-fields.md` (the block-form step format)
- `defaults/manager.md` (manager instructions, see PR #79)
- Example playbooks, including `hello.yaml` and the writer role that onboarding creates in `.paseo/plugins/playbooks/`
- PRs worth reading for design rationale: #10 (sub-playbooks), #62/#63 (step kind blocks), #64 (singleton playbooks, hand-off steps, conditional steps), #79 (manager instructions)

## 3. What was learned about Playbooks (from search snippets only)

**Treat everything here as provisional until verified against the repo.**

- Playbooks is a Paseo plugin by `lerenn`. A "Playbook Manager" agent runs declarative YAML playbooks. Each step is started as a **subagent**, in sequence, in parallel, or in loops, up to **human approval gates**.
- The plugin itself enforces the graph (`needs`, outcomes, `goto` loops, human gates) and keeps run state on the Paseo daemon. The manager agent starts the steps.
- Step kinds mentioned in snippets: **role** (a named subagent with a prompt), **gate** (human approval question), **script** (executables from the playbook's `scripts/` folder, run in the run's worktree), and **playbook** (another playbook in the same folder used as a building block).
- Steps have an `id` and can declare `needs: [...]` to form a dependency graph.
- Conditional steps, "hand-off" steps, and singleton playbooks exist (PR #64).
- **Format is pre-1.0 and had a breaking change.** Each step's kind became a block, e.g. `role: { name: reviewer, prompt: "…" }` and `gate: { question: "…" }`, replacing the older flat style (`role: reviewer` plus a separate `prompt`). Plugin listing was updated from v0.23.1 to v0.41.1. Requires Paseo >= 0.14.0.
- Fragment from PR #10 showing sub-playbook use:
  ```yaml
  steps:
    - id: pr
      playbook: pr
    - id: approve
      needs: [pr]
      gate: Release i…   # truncated in snippet
  ```
- Separate from Playbooks, the Paseo CLI docs show a loop pattern where one agent runs work and another returns a structured verdict via `--output-schema` (e.g. `{"criteria_met": boolean}`), repeating until the criteria are met. Agents launched from an existing agent become its subagents in the same workspace. Providers can be chosen per run with `--provider`.

### Sources found

- <https://github.com/lerenn/paseo-playbooks>
- <https://playbooks.paseo.lerenn.dev/>
- <https://paseo.sh/plugins/lerenn/playbooks>
- <https://paseo.sh/docs/cli>
- <https://github.com/getpaseo/paseo/blob/main/public-docs/cli.md>
- <https://github.com/getpaseo/plugins/issues/2149> (listing update to v0.41.1)

## 4. Open questions to verify in the repo

- Can a role pin a specific **model** (not just provider)? How is that expressed, and is there a default/override hierarchy?
- How are **outcomes** declared and consumed (pass/fail, named outcomes, structured output)?
- How does a failed step escalate, retry, or loop back? Is there a loop/iteration cap?
- What are the "Known limits" the README documents?
- How does a playbook receive input (e.g., a ticket ID or ticket body) at run start?
- Can this pattern be used **outside Paseo** (plain Claude Code + Jira), or does it depend on the Paseo daemon? If it depends on Paseo, which ideas port over and which do not?

## 5. Design thinking so far: the "assembly line"

**Principle:** the end product is a hardened plan that cheaper builder models can execute **without inferring anything**. All questions are answered upstream. Builders are doers.

### Model tiers as I think of them

| Tier | Character | Role in this workflow |
|---|---|---|
| Haiku | Competent doer; won't handle real complexity or infer much | Executes fully specified tasks |
| Sonnet | Capable, multi-step, can infer, but less foresight than Opus | Intake, design conversation, moderate-ambiguity tasks, fallback |
| Opus | Most foresight, thinks multi-dimensionally, but can nitpick forever ("the problem of infinite halves") | Hardening gate only |

### Stages

1. **Intake (Sonnet).** Turn loose input (conversation transcripts, notes, ideas) into a structured brief; ask clarifying questions.
2. **Design iteration (Sonnet, with me).** Back-and-forth until a design takes shape. Cheap, so free to revise.
3. **Hardening gate (Opus, pass/fail).** Attack the spec: find unstated assumptions, verify every phase has an explicit exit condition, confirm each acceptance criterion is verifiable by a tool. Output is a verdict plus a specific defect list, **not a rewrite**. Needs a fixed review scope and a stop rule (e.g., "only flag issues that would make a builder fail or guess") to prevent infinite nitpicking.
4. **Execution (Haiku, Sonnet for harder tasks).** Builders run fully specified tasks. If a builder hits a judgment call it **stops and escalates** rather than inferring.
5. **Verification (tool-based, not model opinion).** After each phase, run machine-checkable criteria: tests, schema validation, Jira field checks, etc.

**Feedback rule:** if a spec cannot pass the gate because its exit conditions can't be expressed as tool checks, it returns to design iteration instead of moving downstream.

### Key insight to preserve

Trust in autonomous builders comes from giving them **tools to verify their own work against explicit criteria**, so I don't have to keep revising their output. If a phase's exit condition can't be checked mechanically, the spec isn't ready.

## 6. Mapping to Playbooks concepts (hypotheses to test)

- Each stage above is probably a **role** step; the hardening gate is a role step with a structured pass/fail outcome, **not** a human `gate` (though a human gate could follow it).
- The build/verify cycle looks like a **`goto` loop** with an outcome-driven exit, similar to the CLI `--output-schema` verdict pattern.
- Builder escalation maps to an outcome that routes to a Sonnet/Opus step or a human gate.
- Per-step model assignment is the central requirement; confirm it is supported.
- A larger pipeline could be composed from **sub-playbooks** (e.g., `harden-spec`, `build-phase`, `verify-phase`) so each stays small and reusable.

## 7. Suggested next actions for Claude Code

1. Clone/read the repo and answer the open questions in section 4 with quoted YAML.
2. Summarize the current step schema and the model-selection mechanism in a short reference.
3. Draft a first workflow YAML for the Jira-ticket pipeline using the five stages above, flagging anything that doesn't map cleanly.
4. List what's needed to run this with Claude Code alone if Paseo isn't a dependency I want to take on.
