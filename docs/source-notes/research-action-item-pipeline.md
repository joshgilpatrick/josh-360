# Design Notes: Research / Action-Item Workflow (Non-Code Tasks)

_Context file for continuing in Claude Code. Companion to `playbook-workflow-handoff.md`, which covers the software-development pipeline and the Paseo Playbooks research. Written 2026-11-13._

## 1. Problem

I get emails asking me to dig into data, query databases, or find something to answer a question about an application I'm responsible for. I forward these to the agent-services mailbox (eventuswh.com), where an agent workflow picks them up. I want to do a better job of this than the current workflow.

These tasks are **not** feature development. The dev-planning machinery (spec hardening, phased build plans, PR delivery) is too heavy for them. Applying it leads to circular conversations with the agent and over-engineering a task that may just be "answer an email" or "find a file on my computer and email it to me."

## 2. Core idea

Every inbound item becomes a single **action item**: a verb plus a deliverable. Examples: answer a question with data, reproduce and diagnose a bug, find a file and email it, draft a reply.

The pipeline's job is to execute that action item and return the deliverable. A code plan is produced only when the action item actually calls for code. In other words, **planning is one branch, not the trunk.** Depth of process should scale to the weight of the task and the uncertainty about it.

## 3. Pipeline

1. **Intake / normalize.** Turn the messy forwarded email into a small structured record (see section 4).
2. **Route on two independent axes.**
   - **Project / application** (e.g., PIMS). Drives which context to load: codebase, databases, standing docs.
   - **Task type.** Drives which workflow runs. Proposed closed list: bug, data analysis, feature request, how-to, access request, find-and-send file, and `unclear/other`. A closed list keeps routing predictable.
3. **Jira lookup (the memory layer).** Search tickets for the routed project for similar or already-answered questions. Bias the search toward the same task type. Outcomes:
   - closed ticket that answers it: draft the reply from that resolution
   - open ticket: answer with known status
   - no match: fall through to investigation
4. **Confidence fork** (see section 5).
5. **Triage by weight.** Simple action items go straight to a doer plus a verify step. Only genuinely complex ones go into the heavier plan-and-build path (the dev pipeline).
6. **Execute** (investigate, query, read code, draft).
7. **Verify** that the question was actually answered and that any numbers and sources hold up.
8. **Deliver** the answer back to me, with sources and queries used.
9. **Capture.** If solved from scratch, propose a new Jira ticket so the answer is available next time. Any proposed ticket must be written with Gherkin (Given/When/Then) scenarios in the description.

## 4. Intake record (the contract for the whole pipeline)

Downstream steps read clean fields instead of re-parsing prose, which is what makes cheaper models reliable. Starting fields to refine:

- the question, restated plainly
- project / application
- task type (from the closed list)
- entities mentioned (application, cohort, date range, facility, file name, etc.)
- requester
- deadline
- deliverable format
- search terms and synonyms for the Jira lookup
- assumptions / unresolved items

## 5. Confidence fork: avoiding "overconfident about the deliverable"

**The main pitfall:** when there is no prior context, the agent is very confident about what the deliverable should be, misses the mark, and I have to come back for clarification.

**Design decisions so far:**

- **No confirmation checkpoint by default.** The agent only pings me when it genuinely needs to.
- **The trigger must be observable signals, not the agent's self-reported confidence** (self-reported confidence is the overconfident behavior we're trying to avoid). Pause and ask when any of these fire:
  - no matching Jira ticket
  - task type comes back `unclear/other`
  - a required input can't be resolved (ambiguous date range, file not found, etc.)
- A match to a prior action item earns confidence: the earlier deliverable tells us what this one should be, so proceed without interrupting.
- **Keep any ping tiny.** Show only the restated question, task type, deliverable format, and the specific assumption or gap. It should be answerable in one sentence and let the run continue. It must not be a plan document.

## 6. Model assignment (starting point)

| Step | Starting model | Notes |
|---|---|---|
| Intake / normalize | Sonnet | Classification and extraction |
| Routing (project + type) | Sonnet | A wrong project means wrong context and a wasted run |
| Jira lookup | **Haiku first** | Decided to start cheap and measure |
| Execution | Matched to task weight | Haiku for mechanical, Sonnet for multi-step |
| Verification | Tool-based where possible | Queries re-run, numbers cross-checked |

**Known risk with Haiku on Jira lookup:** it may match the email's wording too literally and miss a ticket phrased differently, reporting "nothing found" and triggering redundant work. Mitigations:

- have the intake step emit search terms and synonyms so Haiku matches on a richer set than the raw email text
- track the false-negative rate early and bump just this step to Sonnet if it misses things

## 7. Open questions

- What is the final field list for the intake record, and the final task-type list?
- How is "similar ticket" defined and judged? Is Haiku enough to judge whether a ticket truly answers the question, or just to retrieve candidates?
- For live database queries: does the agent run them autonomously, or hand me a draft query to approve first? (Left unanswered in discussion; matters for HIPAA-covered data.)
- How does the agent find and load the right project context per route (repo paths, DB access, docs)? Is there a project registry file?
- How does a "find a file on my computer" action item work given where the agent runs?
- Where is the line between the light path and the heavy plan-and-build path? What signals promote a task?
- How are the intake record and run state passed between steps (and if using Paseo Playbooks, how do outcomes and structured output carry it)?

## 8. Suggested next actions for Claude Code

1. Finish researching the Playbooks repo (see `playbook-workflow-handoff.md`), especially per-step model selection, outcomes, and conditional steps, since the confidence fork and triage steps need both.
2. Draft the intake record as a schema (JSON Schema or YAML) with the closed task-type list.
3. Draft a workflow YAML for this pipeline: intake, route, Jira lookup, confidence fork, triage, execute, verify, deliver, capture.
4. Define the escalation ping format and the observable triggers precisely.
5. Identify which pieces can be reused from the existing agent-services email workflow.
