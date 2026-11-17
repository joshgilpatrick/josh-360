# Josh 360: Vision and Roadmap

## Contents

- [Summary](#summary)
- [What it must do, and what it must never become](#what-it-must-do-and-what-it-must-never-become)
- [The three layers](#the-three-layers)
- [The ledger and memory](#the-ledger-and-memory)
- [Agent graphs](#agent-graphs)
- [How the system measures and improves itself](#how-the-system-measures-and-improves-itself)
- [Standing rules](#standing-rules)
- [What exists today](#what-exists-today)
- [Roadmap](#roadmap)
- [How the build runs without babysitting](#how-the-build-runs-without-babysitting)
- [Decisions from the question round](#decisions-from-the-question-round)
- [Sources](#sources)

Approved by Josh Gilpatrick on 15 November 2026. Copied into this repository from the planning document on 16 November 2026. The build is tracked in Jira under the epic JP-94.

## Summary

Josh 360 is the single home for how Josh gets work done with AI agents. It has three parts: one local record of every agent session, one set of conventions for tickets, and one set of portable workflows that carry a ticket from idea to sign-off. It is a data layer and a framework first. A dashboard comes later.

The aim, in Josh's words, is to sit "as close to the higher level of project planning/ticket prioritization as possible" and not be "the bottleneck for a dozen agent CLI sessions at any given moment".

Josh approved this vision and roadmap on 15 November 2026, after a brainstorm and a question round that settled every open point. The build is tracked in Jira under the epic [JP-94](https://eventuswh-analytics.atlassian.net/browse/JP-94), with 39 tickets from JP-95 to JP-133.

Phase one has four deliverables, which Josh named:

1. A unified data model.
2. One repository for every part of his developer experience (DevEx).
3. A source of truth for agent workflows: action item triage, ticket creation, ticket triage, and ticket processing, for development and non-development work alike.
4. A consolidation of the background processes on his work laptop.

## What it must do, and what it must never become

These are Josh's own requirements. They are the test every later design choice has to pass.

**It must:**

- Log every session quietly, with no forms and no setup at the start of a session.
- Use AI only upstream, to turn sessions into data. Analysis happens downstream, on demand.
- Add little or no model cost. It reuses tokens that are already being spent.
- Give every session a home: a ticket, then an epic, then at least an area of responsibility.
- Leave no orphan tickets. Every ticket ties to a broader purpose.
- Stay tool-agnostic. Jira, Linear, Agent Manager and the command-line tools are extensions that plug in.
- Keep data on the laptop. There is no cloud database for now.
- Let agents pull small, targeted answers from memory. Nothing is pushed into a session.

**It must never become:**

- A scheduled report, or an agent that keeps Josh on task.
- A critic running in the background.
- A framework he has to hold in mind for every task, or one that leaves him "in debt" after a busy day.
- App features built before the data and conventions are solid. Agent Command Center, action-triage and Session Atlas each started with the interface.
- An epic he has to babysit.

**Five guardrails follow from this.** Josh asked for a design that neither force-feeds agents instructions nor leaves them to interpret priorities and conventions on their own.

1. Hooks and scripts write the facts. Agents are not asked to log themselves.
2. Memory is pull only.
3. What an agent says about its own work is a claim. "Done" is always read from git and the ticket.
4. Conventions live in tools. A script refuses the wrong thing, so no paragraph has to ask agents to avoid it.
5. Working agents never see priorities. Only the step that links work to priorities does, and it picks from a list.

## The three layers

Work sits in three layers, and Josh 360 only adds the top one. The middle layer already exists in the department convention Josh wrote (Technology Department Work Architecture, draft v0.2).

| Layer | What it is | Where it lives |
| --- | --- | --- |
| Priorities | Josh's own view of what he is answerable for | A short file in josh-360 that Josh edits by hand |
| Areas, initiatives, epics, work items | The department structure | Atlassian Goals, the Jira TECH space, and the CI, AD and JP spaces. Linear for personal work. |
| Sessions | Every agent session, ticketed or not | The ledger |

**Priorities.** Josh named six at a leadership forum, as "the things that people think of me as accountable for":

1. Athena
2. EQuIP
3. PIMS
4. M&A: clinical data transfer
5. Clinician tech stack and UX
6. AI scribing utilization
7. Internal Systems & Applications (added by Josh at the phase 1 question sitting, JP-106, 16 November 2026)

They do not line up one-to-one with the department's areas of responsibility, and they do not need to. Each priority points at the areas or initiatives it covers, and Jira stays the source of truth underneath. Two more homes sit beside the seven:

- **DevEx** is a real priority that only Josh 360 shows. Josh would not list it in front of the department.
- **Unassigned** is left honest. Nothing is forced into a bucket, so distractions can be counted.

**How a session finds its home.** The common cases need no AI and no question to Josh.

1. The branch name gives the ticket. The convention is one branch per work item, named after its key.
2. The ticket gives the epic, and the epic gives the initiative or area, through Jira's own links.
3. With no ticket, the folder gives the system through the system registry, and the system gives the area.
4. If the folder is unknown, the session is Unassigned. A helper asks only here, or when work crosses the ticket threshold.

**Work and personal.** Both appear, clearly separated. Jira holds work and Linear holds personal. Personal work may stay on a second machine for now.

**Weekly priorities** are tickets or epics Josh marks in Jira, not a file. How they are marked and shown is designed with the dashboard in phase 3.

## The ledger and memory

The ledger is one local, append-only database. It records facts about sessions and workflow runs, and it holds Josh's decisions so that his input shrinks over time.

### What one session entry holds

| Part | Examples | Written by |
| --- | --- | --- |
| Facts | Folder, branch, start and end time, cost, files made, commits, pull requests, ticket keys | Hooks, with no model involved |
| Summary, about five lines | What the session was about and how it ended | Copied from the session title, the first message and the session's STATE.md timeline. One small Haiku call only when those are too thin. |
| Links | Ticket, workflow run and step, area | Derived as described under "How a session finds its home" |

The summary is written once a session has gone quiet, and rewritten if the session is resumed. Nothing depends on a closeout step Josh would have to remember. The summary matters most for sessions with no ticket, such as a question or a strategy conversation, because nothing else describes them.

### Loose ends are computed, never logged

Josh defined a loose end as any of these:

- A session with commits but no branch or pull request.
- A local branch with no remote branch.
- A ticket that is not Done.
- An open pull request.
- A leftover worktree, or an orphaned branch that was not kept on purpose.

Every item is a fact that can be checked at the moment Josh asks. The ledger only remembers which session touched which folder, branch and ticket. A script then reads git and Jira as they are. A day when Josh skips the system loses nothing, so there is no debt.

Session closeout is an agent Josh calls when he wants it. It works from the loose-ends list.

### Memory has four homes

| What is remembered | Home | Why there |
| --- | --- | --- |
| Tickets and what was delivered | Jira and Linear | Other people create tickets too. Duplicate checks and "has this been answered before" look here, live. |
| What happened: sessions, workflow runs | The ledger | These are facts written by hooks and scripts. |
| Josh's decisions: a question he answered and where it applies | The ledger | Decisions are also made in Linear and in sessions with no ticket. They need exact fields, and some are private. |
| Rules: decisions Josh has promoted | Files in the josh-360 repository | The conventions and the system registry. |

When an answer affects a ticket, it is also written into the ticket's own sections, so the ticket stays a complete contract. The ticket holds a requirement for one piece of work. The ledger holds the precedent for future work.

### How Josh's input shrinks

Every question a workflow asks Josh is saved with his answer, the ticket, the system, the type of work and the step that asked. Josh moves each category of question through three stages himself. An agent never makes that move.

1. **Ask and record.** Everything comes to Josh. This is the starting point, and all design questions get his input.
2. **Suggest and confirm.** The question arrives with an answer filled in and the earlier decision quoted beside it. Josh confirms or changes it.
3. **Answer and show.** The workflow answers from memory and continues. The pull request Josh signs off lists every question answered this way, so he can overrule any of them.

Four rules keep this safe:

- An answer from memory must quote the decision it rests on. A script drops any that do not.
- An overruled decision is marked superseded and is never used again.
- A question Josh answers that had a usable precedent is recorded as a miss.
- An answer Josh has given several times becomes a written rule.

Lookup is exact: same system, same type of work, same step. There is no search by meaning and no wiki rewritten by an AI to start with. Enough recorded misses is the signal to add something smarter.

### What the ledger replaces

- Per-project changelog files, which cause merge conflicts across branches.
- Session Atlas's focus summaries, which call Haiku after every turn.
- The `/focus` file and its three hooks, which still run in every session although Josh never uses `/focus`.

STATE.md stays as the one record of what a session is doing.

## Agent graphs

A graph is a workflow that carries one ticket through named steps, each done by an agent, a script or Josh. Josh 360 stores graphs as portable parts, so the tool that runs them can change without rewriting them. The longer aim is an agentic task-completion engine and software factory.

### The four graphs

*Diagram not reproduced here: the pipeline map, with four graphs, two gates and three points where Josh steps in. The table below carries the same content.*

Solid arrows are the path of a ticket. Dashed lines mark where Josh steps in. Questions from any step, spec approvals and shared-write approvals all reach him through the same queue: the Needs you tab in action-triage, plus a Jira flag on the ticket.

| Graph | Takes in | Produces | State of the design |
| --- | --- | --- | --- |
| Ticket creation | A forwarded email, a Notion action item, a to-do, or a session that crossed the ticket threshold | A complete ticket, or a parent with children | Designed in phase 1 (JP-102), built in phase 1 (JP-121) |
| Ticket triage and sign-off | A drafted ticket | A Ready ticket routed to the right path, or a ticket sent back for more input | Designed in phase 1 (JP-103), built in phase 1 (JP-122) |
| Development pipeline | A Ready development ticket | A reviewed pull request | Built new from the 22-step draft, which had not yet run on a real ticket. Built in phase 1 (JP-115). The sprint skill keeps running until this graph replaces it. |
| Non-development pipeline | A Ready non-development ticket | The deliverable, such as an answer, a file or a draft, with its sources | Designed in phase 1 (JP-104), built in phase 1 (JP-123) |

Everything with a deliverable becomes a ticket first. Process depth still matches the weight of the task, so "find a file and email it" gets a light ticket and a short path.

### Portable parts

| Part | What it is |
| --- | --- |
| Roles | A job in a graph, such as builder or code reviewer: its instructions, whether it may change things, and its model tier |
| Agents | A specific worker Josh has designed for a kind of work. A step names a role, and can name the agent that fills it, directly or by a rule such as the ticket's system label. |
| Gate scripts | Checks that take inputs and print an outcome, with no model involved |
| Contracts | The formats passed between steps: the intake record, the spec, the evidence file, the feedback files |
| Tiers | Cheap, mid and gate, mapped to models in one file |
| Graph file | One neutral YAML file per graph: the steps, their outcomes, the loops and where Josh is asked |

Graphs share steps as well as roles. The same parts recur in every set of notes: an intake record, classification by type and by system, a Jira lookup, a completeness check, escalation on observable gaps, and a ping that takes one sentence to answer.

### The walker

The walker is one small script that holds the graph logic. Given the graph, the run so far and the last outcome, it prints the next step. The tool that runs the graph only has to start the session the walker names. Agent Manager comes first. Claude Code desktop or a Paseo plugin could call the same walker later.

The walker also writes each step to the ledger as it happens: the run, the step, the outcome, the loop count, the session and the model tier.

### What every graph declares

Each graph file opens with a short header:

- The Jira status each stretch of the graph maps to. Only a script moves the ticket.
- The entry gate and the exit gate.
- Every point where Josh is asked.
- What is written to the ledger.
- For each step, whether it only reads, writes something of Josh's, or writes something shared. A checker refuses a graph where a shared write has no approval step.

### Gates

- **Ready is the entry gate.** A separate sign-off agent marks a ticket Ready or sends it back. It never judges a ticket it wrote.
- **A Ready ticket has no open questions for Josh.** The exception is a ticket whose purpose is to produce a spec, a design or a plan. Those use the Research ticket type.
- **No loose ends is the exit gate.**

### Where Josh appears

1. Prioritising tickets.
2. Answering questions. They arrive in one "needs you" queue in a short standard form. That ticket parks and gets the Jira flag, and everything else keeps moving.
3. Approving specs. At first every design question gets his input. This shrinks through the three stages described under "How Josh's input shrinks".
4. Signing off pull requests and deliverables.
5. Approving shared writes and permanent deletions.

### Three gaps in the drafted development pipeline

Josh said these must be resolved, and he accepted these fixes.

| Gap | Fix |
| --- | --- |
| Six places can wait on Josh | Designer questions go back to triage. Builder escalations, blocked audits and fixer questions go to the "needs you" queue. |
| The Jira ticket never moves | Design and hardening map to Design/Planning, building to In Progress, the audit to Code Review, ready-for-human to Validation, and merge plus cleanup to Done. |
| The spec, evidence and rework history vanish with the worktree | The walker records every step. At closeout the spec and evidence are saved with the run, outside the repository. |

### Habits to keep from the drafted pipeline

- Scripts decide and models judge.
- A reviewer can only cite the plan, and a script deletes any defect that does not quote it.
- Only scripts set labels and move tickets.
- Each step uses the cheapest model that can do it.
- Every loop has a limit that ends at a human.

## How the system measures and improves itself

Josh confirmed this design on 15 November 2026. He agreed it is worth the tokens to run something at the end of a session and something once a week that mines for improvements, as long as nothing runs on every turn.

The aim of Josh 360 is that Josh spends his days prioritising and signing off, and that his input shrinks over time. So "is it working" means "does it need Josh less, without the work getting worse". Counting that needs no model. Finding out why needs a small amount of model time, spent once per session and once a week, and never per turn.

### What gets counted

| Question | Measure | Where it comes from |
| --- | --- | --- |
| Is Josh needed less? | Josh's messages per finished ticket. Times a ticket waited on him, and for how long. | Session records and the "needs you" queue |
| Is the work right first time? | Share of PRs and deliverables signed off without being sent back. Share of tickets the sign-off agent sent back. Fix rounds after review. | Graph-run history |
| Is the house clean? | Number and age of loose ends | Computed from git and tickets |
| Is memory earning its keep? | Share of questions answered from precedent. Suggestions accepted against suggestions overruled. Lookups that found nothing. | Decision records |
| What does it cost? | Spend and time per ticket, by step | The existing cost records |
| Is the harness getting heavier? | Size of the instructions a session loads. Skills, rules and jobs nobody has used. | Facts written by hooks |

The first two rows are read together as the headline. If Josh's messages per finished ticket falls while the right-first-time share holds, the system is working. If the first falls and the second falls with it, the system is only skipping him.

A starting figure is taken during the inventory, from the session history already on the laptop, so later change can be shown against it.

### What each session leaves behind

Two things are written when a session goes quiet. Neither is shown to Josh at the time.

**Facts, for every session, by script.** A script reads the session's transcript and its STATE.md record and logs counts. No model is involved.

| Fact | What it hints at |
| --- | --- |
| Josh's messages, split into answers to a question and messages he sent unprompted | How much steering the session needed |
| Times Josh stopped the agent mid-step | The agent was heading the wrong way |
| Failed commands, and the same command failing again | A tool or environment problem, or a missing instruction |
| The same file read many times | The agent kept working out something it should have been told |
| How full the context was at the first turn, and how often it ran out | The harness is too heavy, or the task was too big for one session |
| Skills, agents and tools used, against those loaded | What earns its place and what is dead weight |
| Time waiting on Josh against time working | Where he is the bottleneck |
| U-turns and dead ends already written in STATE.md | Wasted effort, recorded by the session itself at no extra cost |

**What compaction already produces, and how it is reused.** Nothing new is added at compaction time. The harness already does three things there, checked in its hooks on 15 November. Just before each compaction a small model rewrites the session's STATE.md under fixed headings, including U-turns, Dead ends, Findings with whether Josh was told, and Tests with known failures. Just after, the compaction summary is saved to a file. The number of compactions is counted. Today nothing collects any of it, and a session's STATE folder is deleted after 30 days without changes. So the ledger script does three things, none needing a model:

- It copies the U-turns, dead ends and untold findings into the ledger when the session goes quiet, before the 30-day cleanup.
- It logs compactions per session, and so per ticket. A ticket that needed several compactions was probably too big, which is feedback for ticket creation.
- For a long session it hands the debrief the STATE.md record and the saved compaction summaries in place of the whole transcript, so the debrief costs about the same however long the session ran.

Compaction only happens in long sessions, so it can feed the picture but cannot be the main source. The compaction hook keeps its one job, which is protecting the session's own memory.

**A debrief, for sessions that earn one, by one small model call.** A separate small model reads a trimmed copy of the session: Josh's messages, the agent's replies, the error lines and the STATE.md record, with tool output left out. It has no tools. It fills in a fixed form: how the session ended, from a short list, and up to five moments of friction. Each moment has a kind from the list below, the thing it touched (a skill, rule, role, graph step, system or tool) and a pointer to the turn where it happened.

1. Josh corrected the agent.
2. Josh handed over something the agent could have looked up.
3. Josh restated a rule that is already written down.
4. The agent asked a question that already has a recorded answer.
5. The agent went down a wrong path and came back.
6. A tool or environment failure cost real time.
7. A skill or rule should have applied and did not.
8. A manual step was repeated that a script could do.
9. Work was reported as done and was not.

This is the same call that writes the session's five summary lines, so a session gets at most one model call when it goes quiet. A script decides which sessions earn it: every session that is part of a graph run, and any other session whose facts show friction. Short clean sessions get facts only.

The working agent never writes its own debrief. Sessions often end by closing the terminal, so a closing step would not run reliably, and an agent grading itself is a claim and not a fact.

The form stores codes and pointers, never quoted text. Transcripts can contain patient data, and the ledger must not.

### The weekly review

Once a week one agent reads the ledger, not the transcripts. It groups the week's facts, debriefs, graph-run history and memory misses by the thing they touched, and looks for repeats: the same kind of friction on the same target three or more times, or a count moving the wrong way. One-offs are ignored. For the few patterns at the top it then opens the transcripts at the stored pointers, to confirm the pattern and work out the fix. Josh can also run it on demand. It runs on the laptop, where the ledger lives, as one of the consolidated background jobs.

This is Josh's existing /reflect skill pointed at a week of flagged sessions in place of one session. Its rules carry over:

- Every finding cites its evidence. A script drops any finding that cites none.
- The fix goes to an existing home first. In order: a script or gate that enforces it, moving or tightening guidance that exists but did not land, tuning the description of a skill that should have fired, editing the skill, role or rule that has the gap, and only then something new.
- If guidance already exists and was not followed, adding more text is not the fix.
- Retiring something counts as a finding.

The weekly review writes no report. Its output is improvement tickets, inside the cap, and everything else stays in the ledger as rows. /reflect itself stays available for a deep look at a single session.

### How a finding becomes a change

Changes to the system go through the system's own pipeline, so improvement work is specified, tested and reviewed like any other work.

1. **A pattern is found.** Usually by the weekly review. Sooner by a threshold script when a count leaves no doubt, such as the same step failing three times for the same reason, or the same question reaching Josh three times. The thresholds live in a file Josh can edit.
2. **The pattern becomes a ticket.** The ticket goes in the DevEx backlog with the ledger rows that triggered it attached, and passes the Ready gate like any other.
3. **Every change names the number it should move.** For example, "tickets sent back at the hardening step should fall". That is a claim, and the ledger checks it after the next ten runs. A change that did not move its number gets a follow-up ticket proposing to undo it.
4. **Josh prioritises.** Improvement tickets wait in the backlog with everything else. Nothing pings him and nothing blocks.

Memory improves the same way, using the rules already set out under the ledger and memory. A repeated answer becomes a candidate rule, an overruled answer is marked superseded, and a miss is recorded. The same counts tell Josh when a category has earned its next stage. A category that is overruled after promotion drops back a stage on its own.

### What it may and may not do alone

The system may make itself better without Josh. It may never reduce Josh's oversight without Josh.

| Kind of change | Who decides |
| --- | --- |
| Fixing a role's instructions, a gate script, a graph step or a rule | Agents, after review by a separate agent. Josh sees it in the ledger. |
| Retiring something unused | Agents switch it off and archive it. Permanent deletion goes on the phase's approval list. |
| Promoting a category to a later memory stage | Josh |
| Removing an approval step or a gate | Josh |
| Changing a threshold or a budget | Josh |

### Keeping the improver from becoming the problem

| Risk | Guard |
| --- | --- |
| A flood of suggestions that feels like debt | A cap on open improvement tickets, set at five. New patterns wait in the ledger until one closes. |
| The harness grows with every fix | A size budget for what a session loads. A change that adds instructions must stay inside it or remove something. A script is preferred to more instructions, and unused items are proposed for retirement as readily as new ones are proposed. |
| Paying a model to watch | No model runs per turn. There is one small call for a session that earns it and one run a week, and both appear in the cost records, so what improving costs can be set against what it saves. The Atlas per-turn summary worker is retired. The inventory decides whether claude-mem and the Obsidian transcript staging are replaced too, so that this is not a fourth thing reading transcripts. |
| It turns into a critic of Josh | Every kind of friction on the list is a way the system let Josh down. Nothing rates his choices. Time spent outside the seven priorities shows on his own view and feeds no ticket. |
| An agent grades its own work | The working agent never writes its debrief, and the agent that drafts a change never judges it. The ledger does, from facts. |
| Patient data reaches the ledger | The debrief stores codes and pointers, never quoted text, and the model that writes it has no tools. |
| A transcript carries text meant to steer the reviewer | Transcripts are treated as data. The debrief can only fill in its form, and any change still passes the Ready gate and a separate reviewer. |
| Agents learn to game the numbers | Working agents never see the measures or the debriefs. |

### When each piece arrives

| Phase | What is added |
| --- | --- |
| 1, inventory | The starting figures, and a verdict on the things that read transcripts today |
| 1, ledger | Session facts, the debrief form and the measures as stored queries. Collecting starts early so there is something to mine later. |
| 2 | The weekly review, threshold scripts, improvement tickets and the claim check |
| 3 | A page on the dashboard |

The order inside phase 1 matters. The facts layer is built first and left to run for about two weeks. The debrief form is finalised only after looking at those real rows, so that it asks about friction that actually happens.

**Decided:** the review runs weekly, because a pattern needs repeats and a daily run mostly sees one-offs. The starting thresholds are three repeats, five open improvement tickets and ten runs, kept in a file Josh can edit. The final list of friction kinds is settled after two weeks of real facts.

## Standing rules

These rules were settled in the brainstorm and apply across everything above.

| Topic | Rule |
| --- | --- |
| When work needs a ticket | A ticket is for work with a beginning and an end, where the end is a deliverable. A session that poses a question or holds a strategy conversation needs none. |
| When a session becomes ticketed work | The moment it is about to make its first commit or branch with no ticket linked. The agent offers one line, such as "this has become ticket-sized work, want me to open one?", and carries on either way. A hook can see the same moment. |
| Ticket systems | GitHub issues are out. Jira is for work and Linear is for personal. |
| Reading data | Reading anything Josh personally has access to is always allowed. |
| Writing data | Writes and database changes keep Josh in the loop. A change that affects an application with other users always goes through human approval and the SQL write safety ceremony. |
| Relaxing the write rule | Later, through the same staged trust as decisions, once staging and development conventions make testing safe. |
| Retiring something | Two moves. First it is switched off and archived, which is reversible and needs nobody. Permanent deletion is collected into one list per phase that Josh approves in one sitting. |
| Background services | Josh 360's services start from the one startup manifest in macbook-automations, with no installers of their own. |
| Patient data | No patient data in the ledger, the summaries or the decision records. This extends Josh's existing rule of no PHI in logs. |

## What exists today

Five repositories hold the pieces. Two move onto Josh 360's foundation and two stay separate. Josh's rule for the two that move, from his comment of 15 November: "I plan on preserving most of these projects, I just want them all consolidated on the same foundation." So their features are kept unless the inventory finds a reason to drop one. What changes is what they are built on: one data model, one set of conventions and one set of workflows.

| Repository | What it is today | What happens to it |
| --- | --- | --- |
| josh-360 | Empty | Becomes the home |
| claude-360 (Session Atlas) | A local service that indexes every session, the files it made, its links and its cost, with a dashboard. Two local databases. | Kept, on the shared foundation. Its session index and cost records are the starting point for the ledger, and its dashboard and file catalog keep working on top of the ledger. Its per-turn focus summaries are retired. The inventory gives every feature a verdict. |
| action-triage | A desktop app and a background daemon: action item intake, agent sessions, automatic pull request audit, a "Needs you" tab, and an email desk. Josh is merging its Jira version into main. | Kept, on the shared foundation. The app, its intake, its pull request audit and its "Needs you" tab keep working, and read and write the ledger in place of their own stores. Its intake and audit also feed the graphs. The inventory gives every feature a verdict. |
| claude-harness | Josh's `~/.claude` folder: global rules, about 240 skills, about 30 agent definitions, hooks | Stays separate and gets trimmed. The skills that use Josh 360 are documented in josh-360 so they stay portable. |
| macbook-automations | One login job that starts six background jobs from a manifest. Three are personal chores and three are harness plumbing. | Stays separate. Its startup manifest is reused. |

Josh decided on 15 November that the code of action-triage and Session Atlas moves into josh-360. Their features are kept, and the old repositories are archived once the move is proven. Nothing is deleted without him.

**Overlaps found while reading the code.** These are what the unified data model has to resolve.

- Three stores answer "what is this session doing": the `/focus` file, Session Atlas's focus summary, and STATE.md. None reads the others, and two pay Haiku separately.
- About seven ideas of a task: action item, to-do, GitHub issue, Jira ticket, Linear ticket, task-manager task and focus subtask.
- Two ideas of a session: Session Atlas's record and action-triage's agent session record.
- Four memory mechanisms besides Jira: Session Atlas, the claude-mem plugin with its worker, a hook that stages transcripts for an Obsidian wiki, and dormant context-mode databases.
- Roughly twenty background jobs on the laptop. Six start from the macbook-automations manifest, eleven more are listed there as managed elsewhere, and action-triage and Session Atlas add three. Some belong to tools Josh has moved on from.
- The Session Atlas database was over 5 GB in the storage register Josh's harness wrote on 8 November 2026.

## Roadmap

The work runs in four phases, and nothing in a later phase is built until the gate before it is passed. Phase 1 is where Josh's four deliverables land.

*Diagram not reproduced here: the roadmap, with four phases, three gates and phase 1 in five parts. The sections below carry the same content.*

Each diamond is a check Josh makes before the next phase starts. The order follows his rule of data and framework first.

### Phase 0: requirements

This document. Josh approved it on 15 November 2026. It is committed to josh-360 as the repository's first document.

### Phase 1: foundation

Five parts, in order. Each ends with something Josh can check in a few minutes.

| Part | What it delivers | Which of Josh's four it serves |
| --- | --- | --- |
| 1. Inventory | Every background job, hook, data store, skill and memory mechanism on the work laptop, each with a verdict: keep, migrate, build new or dismantle. A feature list for action-triage and Session Atlas, each feature with its own verdict, on the understanding that most are kept and moved onto the shared foundation. A dismantling plan for whatever is retired. | Feeds the data model and the job consolidation |
| 2. Repository as the home | The ticket conventions for Jira and Linear, the system registry, the priorities file and a map of every DevEx surface | Unified repository |
| 3. Data model and ledger | One schema in place of the separate local databases. Session facts, summaries and links. The loose-ends check and the closeout agent. Decision records at stage one. | Unified data model |
| 4. Graph convention and walker | The portable parts, the neutral graph file, the checker, the walker and the Agent Manager binding. All four graphs are built: the development pipeline runs first, then ticket creation, triage and sign-off, and the non-development pipeline. | Source of truth for agent workflows |
| 5. Background jobs | Jobs folded in or switched off piece by piece, all started from one manifest | Consolidation of background processes |

Two small tickets sit around these parts. The laptop is connected to josh-360 once, at the start, so that later installs arrive by merging. And every phase 1 design question is put to Josh in one sitting, after the design tickets are done.

The gate to phase 2: the development pipeline carries a real ticket to a pull request, a forwarded email becomes a signed-off deliverable in one run, and the stores the ledger replaces are switched off and archived.

Josh moved every graph build into phase 1 on 16 November 2026 ("all graphs need to be phase 1"), and on 17 November moved the forwarded-email run into this gate and gave phase 2 the gate below (JP-147).

### Phase 2: the full pipeline

- The "needs you" queue is in place.
- Decision memory reaches stage two for the first categories of question.
- action-triage and Session Atlas run on the shared foundation, with every feature the inventory marked to keep.

The gate to phase 3: action-triage is archived, with its kept features running in josh-360, and the weekly review has filed its first improvement ticket.

### Phase 3: reflection

- The dashboard: last week at a glance, with work shown under the seven priorities, DevEx and Unassigned.
- Weekly priorities.
- The personal side: Linear and Family Hub.

### Deliberately later

- Shared writes without Josh, once staging conventions exist.
- A custom agent for each system.
- Moving data off the laptop.

## How the build runs without babysitting

Josh is needed only when something permanently destructive is about to happen. In his words: "I can't afford another epic that I am going to have to babysit." This work affects only him, so every other barrier to autonomous completion is removed.

**Decided by Josh:**

- Agents may merge to josh-360 on their own. The passphrase rule in his global instructions does not apply to this repository.
- Most work happens in cloud sessions. A step runs on his laptop only when it has to.
- Reversible steps need nobody: creating files, branches and pull requests, switching a job off, archiving a store.

**What this asks of the plan:**

- Every build ticket for Josh 360 follows Josh 360's own conventions. It is Ready before work starts, with no open questions and with checks a script can run.
- Code is built and tested in the cloud against made-up sample data, never real transcripts, so no patient data leaves the laptop.
- Laptop steps are few and named in advance: reading the live state for the inventory, installing a finished part, and switching old jobs off.
- josh-360 carries its own instruction file that records the merge permission, so every agent session sees it.
- A separate reviewing agent checks each pull request before it merges.
- Each part of phase 1 ends with a short proof page Josh can read in minutes.
- Permanent deletions wait in one list per phase.

**Four more rules cut how often Josh is asked.** He approved them on 15 November:

- The laptop is connected to josh-360 once, at the start. After that, an install reaches the laptop by merging to josh-360.
- Design questions are collected, each with a recommendation, and put to Josh in one sitting per phase. Builds that do not wait on an answer carry on.
- When a build-time choice can be undone, the agent takes its recommended option, records it in `docs/decisions.md` and carries on. Only a permanent deletion or a write to something shared stops the work.
- Merges to Josh's other repositories, deletion lists and proof pages wait for the close of each phase.

That leaves five sittings for Josh: the laptop hookup, the phase 1 design questions, and the close of each of the three phases.

## Decisions from the question round

Josh settled every open question on 15 November 2026. Two of them are designed later, inside their own tickets.

| Question | Decision |
| --- | --- |
| Has the drafted development pipeline run on a real ticket? | No. The development graph is built new from the 22-step draft, and the sprint skill keeps running until the graph replaces it. |
| Where does the "needs you" queue appear? | The Needs you tab in action-triage, plus a Jira flag on the ticket. A question stays until Josh answers it, and the tab becomes the one place for agent decisions. |
| Where is DevEx work ticketed? | The JP space. |
| What does the Linear convention look like? | Linear keeps the using-linear convention. Personal work is designed in phase 3. |
| Where do weekly priorities live? | They are tickets or epics Josh marks in Jira. How they are marked is designed with the dashboard. |
| Does Josh approve the shape of a parent and its children first? | Yes, before anything is created. |
| How does ticket creation choose the space and the parent epic? | From written rules in the system registry. JP is used when nothing matches. |
| What does the duplicate check do with a match? | An open match gets a comment and the agent stops. A Done or Cancelled match gets a new ticket linked to the old one. A new comment notifies every session working on that ticket. |
| Which parts of Session Atlas and action-triage carry over? | Most features are kept. The code of both moves into josh-360, and the old repositories are archived once the move is proven. |
| How do work and personal stay separate across two machines? | Each machine keeps its own ledger for now. The rest is designed in phase 3. |
| What does the dashboard show? | Josh deferred this to the phase 3 design ticket. |

## Sources

This draft was built from the brainstorm thread of 15 November 2026 and the material below. Copies of the documents Josh shared are in the project files under `josh-360/`.

| Source | What it gave |
| --- | --- |
| Josh 360 Brainstorm Handoff (voice session) | The vision, the must-haves and the things it must not become |
| Technology Department Work Architecture, draft v0.2, and its quick reference | The layers of work, the Jira spaces, the ticket formats, the system registry and "Ready means complete" |
| Jira ticket pipeline: playbook YAML, defaults, roles and scripts, swimlane | The drafted development graph and its habits |
| Context prompt: Jira ticket-creation agent workflow | The ticket creation graph's shape and open questions |
| Design notes: research and action-item workflow | The non-development graph's shape, and escalation on observable signals |
| Handoff: tiered-model workflow design and Paseo Playbooks research | The model tiers and the assembly-line principle |
| Repositories read: claude-360, claude-harness, action-triage, macbook-automations | What exists today, including the harness's storage register of 8 November 2026 |
