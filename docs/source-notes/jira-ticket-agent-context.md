# Context prompt: Jira ticket-creation agent workflow

_Paste this into a new session to continue the design. If available, also attach `research-action-item-pipeline.md`, `playbook-workflow-handoff.md`, and `Technology-Department-Work-Architecture.docx` (v0.2)._

---

I'm Josh Gilpatrick, Director of Clinical Informatics & Solutions Architecture at Eventus WholeHealth (a HIPAA-covered post-acute care organization). I want to continue designing an **agent workflow that turns loose inputs into high-quality Jira tickets**. Below is where the design stands. Pick up from "Where to start."

## Goal

I supply an input, either a forwarded email or a Notion action item, and the agent produces a Jira ticket (or a parent plus children) that is **detailed enough for a downstream autonomous agent to execute without guessing**. The ticket is the contract. This workflow may replace an earlier "research/action-item" pipeline that tried to execute the task directly.

## Pipeline shape so far

1. **Intake / normalize.** Turn the email or Notion item into a structured record: question or request restated plainly, entities, requester, deadline, search terms.
2. **Classify** on two axes: the **ticket type** (decides the template) and the **system** it touches (decides context to load).
3. **Duplicate check.** Search existing Jira tickets for a match before creating anything. I decided to start this step on Haiku and upgrade to Sonnet only if it misses matches.
4. **Decompose.** Decide whether the input is one atomic ticket or a parent with children. This is real inference, so it was suggested as an Opus-class step. It should also check that the children add up to the parent's outcome with no gaps or overlaps.
5. **Fill the per-type template** from the input, inferring only what's safe.
6. **Completeness check** against the template. This is the heart of the workflow: the agent refuses to finish until required sections are satisfied.
7. **Escalate only when necessary.** Triggers are observable gaps, not the agent's self-reported confidence: a required field that can't be filled or safely inferred, an unclear type, or an unresolvable input. The ping asks for the one specific missing thing.
8. **Write and link** the ticket(s) following the convention below.

## Per-type requirements

| Type | Required description sections |
|---|---|
| Story (feature) | Problem; desired outcome; scope; acceptance criteria in Gherkin |
| Bug | Steps to reproduce; expected vs. actual; environment; affected system; Gherkin scenario for the fix |
| Task (to-do, e.g. migrate a DB, move a repo) | Specific target; preconditions; done when, in Gherkin |
| Research / analysis | Question; systems and data sources to use; deliverable format; done when |
| Epic (parent) | Goal; phases; done when; related work; branch strategy |

All work items use Gherkin (Given/When/Then) acceptance criteria. Department-level TECH Initiatives use a different "initiative brief" format and are out of scope for this agent unless we decide otherwise.

## Decomposition and branches

- Some inputs (often feature requests) need a parent plus subtasks. Each child must stand on its own, because a downstream agent will run it in isolation.
- **The branch is the unit of work, not the ticket.** Subtasks contributing to the same feature or bug fix should not each get their own branch.
- Convention adopted since: one branch per work item, named after its key. Subtasks commit to their parent's branch. Sibling items share one branch only when the epic states a single-branch strategy.

## Jira convention the agent must follow

From the department proposal (`Technology-Department-Work-Architecture.docx`, v0.2):

- **Site:** `eventuswh-analytics.atlassian.net`. My spaces: **CI** (clinical informatics operational work), **AD** (software: Keystone/Eventus Connect, integrations, automations), **JP** (my personal intake; items that become team work move to CI or AD). **TECH** holds department Initiatives.
- **Layers:** area of responsibility (Atlassian Goals, ongoing) → Initiative (TECH, ends) → Epic (team space, always ends) → work item → subtask.
- All these spaces are **team-managed**, so parent-child links only work within one space. Across spaces, use **Relates** (epic to its TECH Initiative) and **Blocks** (real dependencies only).
- **Required fields:** epics carry the Goals field (area) and a "Done when"; work items carry one **system label** from a controlled list (seeded from current labels like `keystone-platform`, `athena-services`). A separate system registry maps each system to repo, databases, and docs.
- **No mirror epics; every epic ends.** Ongoing work belongs to an area, not an open-ended epic.
- **Ready means complete.** Downstream agents only pick up items in Ready. An item missing required sections stays in Backlog with a comment stating the open question.

## Model tiers

- **Haiku:** competent doer, little inference.
- **Sonnet:** multi-step, can infer.
- **Opus:** most foresight, but prone to endless nitpicking ("the problem of infinite halves"), so it needs a fixed scope and a stop rule.

## Open questions

- Should the agent propose a decomposition and have me approve its shape before creating tickets, or create them and let me fix afterward?
- Who decides branch grouping in practice: the decomposition step, or me?
- How does the agent choose the target space (CI vs. AD vs. JP) and the parent epic?
- What exactly counts as "safely inferable" for each field?
- What's the escalation channel (email reply, Teams, Notion comment)?
- Does the duplicate check update an existing ticket when it finds a match, or just link and stop?

## Where to start

The last question I was asked: **work through the field set for one ticket type in depth, or lock down the overall graph first?** I'd like help deciding, then producing either a per-type template schema or a workflow definition (YAML) for this pipeline.
