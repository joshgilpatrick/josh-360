---
name: ticket-lifecycle
description: Use for any bug, feature or improvement in josh-360, and for any Jira request about Josh 360 work (file, find, update, close a JP ticket; what's on the board). Every change runs through a JP ticket with Gherkin criteria, moved Not Started → Ready → Design/Planning → In Progress → Code Review → Validation → Done.
---

# Tickets

Rules: `docs/WORKFLOW.md` §1. Values, statuses, transition ids and the words for phase, feature and ticket: `.claude/workflow.config.md`. Use the Atlassian connector from a cloud session (ACLI exists only on Josh's laptop).

## Lifecycle

1. **Find before filing.** Search JP for the label and a keyword: `project = JP AND labels = "josh-360" AND text ~ "<keyword>"`. Adopt a match and tighten its criteria instead of duplicating.
2. **Write it** (Not Started) with the template below, parent JP-94, label `josh-360` (plus `improvement` for an improvement), a type, and the `Phase N:` summary prefix. Add a "Blocks" link for each real dependency. A design that needs Josh is its own ticket blocking the build ticket. Never set points, assignees, dates or priorities.
3. **Ready**: a separate agent signs the ticket off (no open questions) and moves it to Ready, or comments what is missing.
4. **Start** (In Progress, or Design/Planning for design work): rename the thread or session so its title starts with the ticket key ("JP-105 Connect the laptop") if it does not already, then comment `Branch: <branch> @ <base-sha7>`. If a ticket already names a branch, continue it.
5. **Build** against the scenarios: each maps to a test named after it. Scope change: edit the description and comment why.
6. **Review** (Code Review): when the PR opens, comment `PR: <url> (branch <branch>)`. At `review:ready-for-human`, move to Validation.
7. **Done** (move it yourself on merge): comment `Merged in <sha>.` and one line per scenario: `✔ Scenario: <title> — <test file or proof path>`.
8. **Session end** with work left: comment what is done, what is next, and `Branch: <branch> @ <sha>`.

Other comments use `result | evidence (commit, PR, run id) | next gate`. Read every write back. Never delete an issue; cancel it (transition `6`).

## Template

Josh's ticket format. Bold labels, real bullets and a real code block, never literal asterisks.

````markdown
**Goal:** one sentence: what is true when this is done.

**First step:** the first concrete thing to read or do.

**Why:** the problem, who it affects, why now.

**In scope:**

* …

**Not in scope:**

* …

**Acceptance criteria:**

```gherkin
Feature: <capability in user terms>

  @auto
  Scenario: <happy path>
    Given <state>
    When <one action>
    Then <observable outcome>
```

**Repository:** josh-360

**Where it runs:** Cloud session (or: Josh's laptop, and why).

**Parent or related:** Parent: JP-94. Related: …

**Decisions already made:**

* …
````

For a bug, add **Current behaviour** (repro steps, actual vs expected, evidence) after **Why**.

## Jira specifics

- Find: `searchJiraIssuesUsingJql`. Read one: `getJiraIssue` (view `evidence` shows links). File: `createJiraIssue` with `projectKey: JP`, `issueType`, `parent: JP-94`, `labels`, and a Markdown description. Edit: `editJiraIssue` (labels are replaced, so send the full list). Comment: `addOrEditJiraIssueComment`.
- Move: `transitionJiraIssue` with the transition id from the config. Every JP transition is open from any status and needs no fields.
- Blocks: the issue link "Blocks". Use the connector's `discover` to find `createJiraIssueLink`, then `executeWrite`.
- No GitHub-for-Jira automation moves tickets here; the merging thread transitions to Done.
- Description markup: if a description comes back flattened, re-send it as Markdown rather than wiki markup.

## Writing scenarios

- One behaviour per scenario; Given is state, When is one action, Then is what someone observes.
- Concrete values ("429", "within 2 minutes", "$15.00"), never adjectives.
- Cover the happy path, the main failure and the boundary the bug lived on; three to six is typical.
- Bugs state the correct behaviour; repro goes in "Current behaviour".
- No implementation names in Then lines unless the caller is code.
