# Ticket conventions

## Contents

- [What this file is](#what-this-file-is)
- [What the existing sources already say](#what-the-existing-sources-already-say)
- [When work needs a ticket](#when-work-needs-a-ticket)
- [Where a ticket lives](#where-a-ticket-lives)
- [Routing a ticket to a space and a parent](#routing-a-ticket-to-a-space-and-a-parent)
- [Issue types](#issue-types)
- [Required sections](#required-sections)
- [The Ready rule](#the-ready-rule)
- [Labels](#labels)
- [Branches](#branches)
- [Statuses and who moves them](#statuses-and-who-moves-them)
- [Writing to Jira](#writing-to-jira)
- [Checking the conventions files](#checking-the-conventions-files)

## What this file is

The rules every agent and script follows for tickets, for all of Josh's work and not only josh-360. Josh asked that the ticket conventions be reviewed and defined here rather than accepted because they exist (JP-98). The rules apply from the moment of writing; a script that enforces a rule is named beside it.

Two data files sit beside this one:

- `conventions/registry.yaml`: every system, with its folders, repositories, area, Jira space, default parent epic and priority.
- `conventions/priorities.yaml`: Josh's seven standing priorities (the six from the leadership forum and Internal Systems & Applications), plus DevEx and Unassigned, and what each covers in Jira.

`scripts/conventions.py` reads both (see [Checking the conventions files](#checking-the-conventions-files)). josh-360's own build workflow (`docs/WORKFLOW.md`) applies these rules to JP-94 and adds its own steps, such as the review ceremony.

## What the existing sources already say

Three sources existed before this file. Where they agree, the rule below keeps it. Where they differ, the last column says what Josh 360 decides.

| Topic | `using-jira` skill (claude-harness) | `using-linear` skill | Department work convention, draft v0.2 (SharePoint) | Josh 360 rule |
| --- | --- | --- | --- | --- |
| Which tracker | Jira for Eventus work, in AD or JP | Linear (team GIL) for personal work | Jira; Atlassian Goals for areas; TECH for initiatives; team spaces for work | Jira for work, Linear for personal, no GitHub issues |
| Choosing the space | Ask when AD or JP is unclear | One board | Each team space has a role; JP is personal intake | The registry decides; JP when nothing matches |
| Types | Epic, Story, Bug, Task, Subtask | bug, feature, improvement, greenfield | Story, Bug, Task, Research, Epic, each with sections | Josh's format for all, Research for spec, design or plan work, sections per type below |
| Acceptance criteria | Gherkin in the description | Gherkin; scenarios become the tests | Gherkin for work items | Gherkin, one behaviour per scenario |
| Ready | Not defined for JP | Todo once the ticket is written | Agents pick up only Ready items; an incomplete item stays in Backlog with its open question | [The Ready rule](#the-ready-rule) |
| Labels | Lowercase canonical repository name | `repo:<name>` plus a type label | One system label from a controlled list, mapped by a system registry | Lowercase repository name, which is the registry's system name |
| Branches | `<KEY>/<slug>` in its own worktree | Not stated | One branch per item, named after its key; subtasks use the parent's branch | [Branches](#branches) |
| Statuses | AD flow named; JP to be checked live; moved by hand, AD has one automation | Moved as work happens | Teams own their workflows | Moved at fixed events by scripts, see [Statuses](#statuses-and-who-moves-them) |
| Parents | Epic when one exists | Phase epic, then feature, then ticket | Every epic ends; areas hold ongoing work; not everything needs a parent | Default epic from the registry, else none; every ticket still has a home through its area |

The department convention is a draft for the department, and its home is the department SharePoint. Josh 360 follows its layers and its "Ready means complete" rule, and does not copy it.

## When work needs a ticket

1. A ticket is for work with a beginning and an end, where the end is a deliverable. A question or a strategy conversation needs none.
2. A session becomes ticketed work the moment it is about to make its first commit or branch with no ticket linked. The agent offers one line ("this has become ticket-sized work, want me to open one?") and carries on either way.
3. Size a ticket for one design-plan-build cycle. If a reviewer could approve half of it, it is two tickets.
4. Find before filing. An open match gets a comment and the agent stops. A Done or Cancelled match gets a new ticket linked to the old one.
5. When work splits into a parent and children, Josh approves the shape before anything is created.

## Where a ticket lives

- **Jira for work.** Site `eventuswh-analytics.atlassian.net`. Spaces and their roles are in the `spaces` list of `conventions/registry.yaml`: JP for Josh's own intake and every DevEx ticket, AD for software work, CI for operational and clinical work. TECH holds department initiatives only; agents never create one and never file a ticket there.
- **Linear for personal work**, under the `using-linear` convention, which stays as it is. Personal work is designed further in phase 3.
- **No GitHub issues.** action-triage's GitHub-issue path is legacy and is being removed.
- **DevEx tickets live in JP**, whatever repository they touch.
- A JP ticket that turns out to be team work moves to CI or AD.

## Routing a ticket to a space and a parent

The space and the parent come from written rules, with no AI, in this order:

1. A ticket key or space named by Josh wins.
2. Otherwise the repository the work changes is looked up in the registry (`python3 scripts/conventions.py lookup --repo <name>`). With no repository yet, the session's folder is looked up (`--folder <path>`).
3. A match gives the space and the parent: the system's `default_epic`, or no parent when it is null.
4. No match: the ticket goes to JP with no parent, and the session is Unassigned. Nothing is guessed from a similar name.

Parents in Jira work only inside one space, so a default epic is always in its system's space. Work in another space connects to an epic or initiative with a Relates link, and to a real dependency with a Blocks link. Only an epic with an end is a default parent; ongoing work belongs to an area, not an open-ended epic. A ticket with no parent still has a home: the registry gives its system's area, and the area gives its priority.

## Issue types

| Type | Use it for |
| --- | --- |
| Epic | A body of work with an end: a deliverable, or one time-boxed cycle of ongoing work (for example one quarter's EQuIP changes). Never open-ended. |
| Story | A capability someone uses or sees. |
| Task | Technical, operational, documentation or process work. |
| Bug | Existing behaviour that is wrong. |
| Research | Work whose deliverable is a spec, a design, a plan or an answer, including every design ticket. |
| Subtask | A step of one parent ticket. Never a container for unrelated work. |

An improvement is a Story or Task with the label `improvement`. In Linear the `using-linear` types apply (bug, feature, improvement, greenfield).

## Required sections

Every Story, Task, Bug and Research ticket uses Josh's format, in this order, with bold labels, real bullets and a real code block:

1. **Goal:** what is true when this is done.
2. **First step:** the first concrete thing to read or do.
3. **Why:** the problem, who it affects, why now.
4. **In scope** and **Not in scope**, as bullets.
5. **Acceptance criteria:** Gherkin in a `gherkin` code block. One behaviour per scenario; Given is a state, When is one action, Then is something observed. In josh-360 each scenario is tagged `@auto`, `@e2e` or `@manual`.
6. **Repository:** the repository that receives the change, as its label.
7. **Where it runs:** a cloud session, or Josh's laptop and why.
8. **Parent or related:** the parent, and Blocks or Relates links.
9. **Decisions already made**, as bullets.

Each type adds sections:

| Type | Adds |
| --- | --- |
| Bug | **Current behaviour**, after Why: steps to reproduce, expected and actual, environment, the affected system. The Gherkin states the correct behaviour. |
| Research | **Question**, **Sources** (systems and data to use) and **Deliverable format**, after Why. The Gherkin says what the deliverable must contain. |
| Epic | **Goal**, **Phases**, **Done when**, **Related work** and **Branch strategy** (one branch per ticket, or one shared branch, see [Branches](#branches)). No acceptance criteria of its own. |
| Subtask | **Goal** and a Gherkin **Done when**. It inherits the rest from its parent. |

No patient data in any section. Refer to a file that holds it by its path only.

## The Ready rule

A Ready ticket has no open questions for Josh. The one exception is a ticket whose purpose is to produce a spec, a design or a plan: its open questions are its work.

- Ready means complete: every required section is filled with something a person or an agent can act on without guessing.
- A separate agent signs a ticket off as Ready, or sends it back with a comment naming the open question. The author of a ticket never marks it Ready.
- A ticket that cannot be completed stays in Not Started (Backlog in spaces that have one) with that comment.
- Agents start only Ready tickets.

## Labels

- Each ticket carries the lowercase name of each repository that will receive changes. That name is the system's `name` in the registry. Child tickets inherit their parent's labels unless they change a different repository.
- The only other label is `improvement`. Product, feature and topic words (for example `equip` or `security`) are not labels; the registry maps a repository to its system and area.
- The team labels on TECH initiatives belong to the department convention and are not used on tickets.
- Labels already in Jira are left as they are. New tickets follow this rule.

## Branches

- One branch per ticket, named after its key: the key first, then `-` and a short slug in lower-case words joined by hyphens, for example `JP-98-conventions`. Agents and scripts make this form (it is what action-triage's daemon and the graphs' `prepare-worktree` make). `/` after the key (`JP-98/conventions`) is the form Josh's global rules use for a branch made by hand; every script that reads a branch accepts both (`ledger/homes.py`, `ledger/offer.py`).
- **Cloud sessions create the branch themselves.** A cloud session starts on a platform branch (`claude/...`). Once the ticket is known, it cuts a branch named after the ticket from the latest `main` (`git checkout -b JP-98-conventions origin/main`), pushes that one (`git push -u origin JP-98-conventions`) and opens the pull request from it. A key-named branch pushes from a cloud session on josh-360 (tested on 17 November 2026, JP-151). Only when the push is refused does the session keep its `claude/...` branch, and then the key goes first in the pull request title and in every commit message.
- The ticket's start comment names the branch (`Branch: <branch> @ <sha>`), whichever form it has.
- A subtask commits to its parent's branch.
- Sibling tickets share one branch only when their epic's **Branch strategy** says so.
- Never two tickets on one branch otherwise.
- Branches that belong to no ticket keep their fixed names: `main`, `laptop-status`, `laptop-pause`.

## Statuses and who moves them

Status moves happen at fixed events, by a script or an automation, never by an agent's judgment of how far along it is. Until the walker does this (phase 1, part 4), the thread doing the work makes exactly these moves, using the transition ids in `.claude/workflow.config.md` for JP:

| Event | JP status |
| --- | --- |
| Ticket written | Not Started |
| A separate agent signs it off | Ready |
| Work starts on a ticket whose deliverable is a spec, a design or a plan | Design/Planning |
| Work starts on any other ticket, an answer or other non-development deliverable included | In Progress |
| Pull request out of draft and labelled `review:needs-agent-audit` | Code Review |
| Pull request labelled `review:ready-for-human` | Validation |
| Merged, and every scenario mapped to its proof | Done |
| Dropped | Cancelled (never deleted) |

AD runs Ready, Design/Planning, In Progress, Code Review, Validation and Done, and an AD automation moves a ticket to Code Review from the pull request label. CI has its own workflow; read its transitions live before moving a CI ticket. Every move is read back.

## Writing to Jira

- Never invent points, assignees, dates or priorities.
- Never delete an issue, an epic or a comment; cancel instead.
- Read every write back and report the key and the status Jira returns.
- Comments that record progress use `result | evidence | next gate`.
- A comment written by a script or an agent on the system's behalf starts with the robot emoji (action-triage's agent header already does; Josh 360 scripts use `🤖 Josh 360 · <script>`). Josh 360 passes new ticket comments to the sessions working on the ticket (JP-118) and skips every comment that starts this way, so the system's own comments are not echoed back.
- Changing Jira's own configuration (workflows, fields, automation) is not part of these conventions.

## Checking the conventions files

`scripts/conventions.py` reads the registry and the priorities file, and writes their JSON copies. It needs Python 3 and PyYAML (`requirements.txt`).

| Command | What it does |
| --- | --- |
| `python3 scripts/conventions.py check` | Validates both files. Exits 1 with one line per problem, each naming the entry: a system with no Jira space, a space or area that is not listed, a default epic outside its space, a folder or repository listed twice, a priority missing or claimed twice. |
| `python3 scripts/conventions.py lookup --folder <path>` | The system, area, space, default epic and priority for a folder. The deepest listed folder wins; a folder no system lists is Unassigned. |
| `python3 scripts/conventions.py lookup --repo <name>` | The same for a repository name, with or without its owner. |
| `python3 scripts/conventions.py priority --epic <KEY>` | The priority a ticket falls under from its epic, initiative (`--initiative`) or area (`--area`), in that order; anything else is Unassigned. |
| `python3 scripts/conventions.py export-json` | Writes `conventions/registry.json` and `conventions/priorities.json`, the same data for code with no YAML reader. With `--check` it writes nothing and exits 1 when a copy is stale. |

`python3 scripts/check.py` runs the check as part of the repository suite, and `tests/test_conventions.py` proves the lookups.
