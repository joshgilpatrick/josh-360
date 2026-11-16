# Josh 360: Context for a Voice Brainstorm

## Contents

- [How to run this conversation](#how-to-run-this-conversation)
- [What Josh 360 is meant to be](#what-josh-360-is-meant-to-be)
- [The four repositories at a glance](#the-four-repositories-at-a-glance)
- [How the repositories fit together](#how-the-repositories-fit-together)
- [Where each repository keeps its data](#where-each-repository-keeps-its-data)
- [Outside tools Josh already uses](#outside-tools-josh-already-uses)
- [Open questions worth exploring](#open-questions-worth-exploring)
- [What to hand back at the end](#what-to-hand-back-at-the-end)

## How to run this conversation

You are a thinking partner for Josh, who will be talking out loud by voice. Josh is a healthcare expert who builds his own tools with AI agents, so keep the language plain and skip jargon.

- This is a brainstorm, not a planning session. Do not design databases, write code, or plan implementation. You do not have access to the repositories, so stay at the level of what things do and what Josh wants.
- Keep your replies short, since they will be read aloud or skimmed between thoughts. Ask one question at a time, and build each question on what Josh just said.
- Let Josh ramble. When he circles back or contradicts himself, play it back to him gently so he can choose.
- Every so often, summarise what you have heard in a few sentences and ask what is wrong or missing.

The conversation has two parts, in this order:

1. **The broader Josh 360 platform.** What Josh wants it to be, for whom, and what a good week looks like with it in place.
2. **Consolidation.** How the three existing repositories could feed one consolidated repository, so there is one place to file tickets against and work on.

## What Josh 360 is meant to be

The working description: a personal, 360-degree workflow platform that brings together an agentic harness (the AI agents and skills Josh works with every day) with a transparent view of:

- high-level professional and personal priorities,
- week-to-week goals,
- a log of agentic coding sessions (what the AI agents worked on, what they produced, what it cost),
- ticket tracking.

Today the agent and session pieces are well built but scattered across separate projects. What is largely missing is the layer on top: Josh's own priorities and weekly goals, and the personal side of life sitting next to the work side.

## The four repositories at a glance

| Repository | What it really is | Dimension of Josh's workflow it supports |
|---|---|---|
| **josh-360** | Empty. A clean slate meant to become the one consolidated home. | The future single place to ticket against and build in. |
| **claude-360** (the app inside is called *Claude Session Atlas*) | A background service on Josh's Mac that records every Claude Code session: its title, project, folder, status, a running "focus" summary (main task, subtasks, open decisions, parked items, deliverables), the files it created, how sessions relate to each other (parent and sub-agents), which pull requests and Jira tickets they link to, and what each session cost. It has a local web dashboard. | **Memory of the work:** "what did my agents do, where is that file, what did it cost, can I pick that session back up?" |
| **claude-harness** (this is Josh's `~/.claude` folder) | Josh's agent toolbox: the standing rules his AI agents follow, about 240 skills (reusable instructions), custom agents and hooks. Skills cover focus mode, weekly review, "what did I get done", sprint running on Jira tickets, starting work on a ticket, Linear tickets, a personal knowledge wiki, task capture, and many work-specific tools. | **How the work gets done:** the habits, guardrails and playbooks the agents run on. |
| **action-triage** (an Eventus work repository) | A desktop app plus a background daemon. It pulls action items from meeting notes and quick to-dos, turns them into GitHub issues, launches AI agent sessions to work them, and runs an automatic code-review step on their pull requests. It has a "Needs you" tab where agents' questions wait for Josh's answer, and an Email Research Desk that turns emails Josh forwards into Jira tickets worked by agents. | **Intake and dispatch:** turning things Josh needs done into agent work, and surfacing what needs him. |

## How the repositories fit together

Think of it as a loop, with each repository owning one stretch of it:

1. **Something comes in.** A meeting action item, a to-do, a forwarded email, an idea. *action-triage* captures it.
2. **It becomes a ticket.** Today that can be a GitHub issue (action-triage), a Jira ticket (Eventus work, via harness skills and the email desk), or a Linear ticket (personal work, via a harness skill). Three ticket systems is part of the sprawl.
3. **Agents work it.** They follow the rules and skills in *claude-harness*. action-triage or the harness's sprint skill launches them.
4. **The work is recorded.** *claude-360* (Session Atlas) logs each session, its focus, files, links and cost.
5. **Josh reviews and reflects.** The weekly-review and "what did I get done" skills, the Atlas dashboard, and action-triage's history and code-review views each give a partial picture.

What no repository does yet: hold Josh's priorities and weekly goals, connect the loop above to them ("is this work moving what matters this week?"), or bring in personal life (family calendar, household tasks).

## Where each repository keeps its data

All of this lives on Josh's Mac today. Nothing is in a shared cloud database yet.

**claude-360 (Session Atlas)**
- One main local database (SQLite, a single-file database) in `~/.claude/atlas/`. It holds sessions, their focus summaries, created files and their versions, the links between sessions, pull requests and Jira tickets, and housekeeping records.
- A second, separate local database for costs (the "cost ledger" in `~/.claude/cost-ledger/`). Atlas only reads it; a separate import step fills it from session transcripts.
- It reads, but does not copy, Claude Code's own session transcripts (the raw conversation files Claude Code writes).
- This is the most structured, query-ready data of the three.

**claude-harness (`~/.claude`)**
- Mostly plain files rather than a database: rules (`AGENTS.md`), skill folders, agent definitions.
- Working state is scattered across small files: per-session focus notes (`session-focus/`), per-session state notes (`session-state/`), sprint state for Jira sprints (`sprint-state/`, JSON files plus a running journal), and a task-manager queue of one small JSON file per task in a OneDrive folder.
- Some skills reach into work databases (Azure SQL, Synapse, Snowflake) and outside tools (Jira, Linear), but those are sources the harness talks to, not data it owns.

**action-triage**
- Meeting action items and to-dos live in a single JSON file (`action-items.json`) that sits in an older project (the Agent Command Center), next to a file of Notion meeting data. A separate background job syncs meetings into it.
- The agent daemon tracks every agent session and code review in a JSON state file (`state.json` under `~/Library/Application Support/action-agent/`), with sibling folders and files for agents' questions waiting on Josh, the code-review queue order, saved session outputs, and screenshots.
- The Email Research Desk keeps its own small SQLite record book linking email threads to Jira tickets and agent workers.
- GitHub itself is a big part of its "database": issues, labels and pull requests carry much of the real state.

**The pattern worth noticing:** three different kinds of storage (a well-shaped local database, loose files, and JSON files plus GitHub), several overlapping ideas of "a task" (action item, to-do, GitHub issue, Jira ticket, Linear ticket, task-manager task, focus subtask), and two overlapping ideas of "a session" (Atlas's session record and action-triage's agent session record).

## Outside tools Josh already uses

- **Linear:** Josh's personal ticket board (used for personal projects, including a family app).
- **Atlassian Jira:** Eventus work tickets (Apps Development and Josh Projects boards), worked through sprint skills.
- **Supabase:** a hosted database Josh has available. What it currently holds was not checked; ask Josh.
- **Family Hub:** a connector to Josh's household system: family calendar and events, household tasks and routines, kids' bounties and allowance.
- **GitHub:** code, issues and pull requests for all of the above.
- **Notion:** source of some meeting data feeding action-triage.

## Open questions worth exploring

Use these as territory, not a script. Pick the one that fits where Josh is.

- When would Josh reach for Josh 360? A Monday plan, a mid-day "what needs me", a Friday look-back, a family Sunday?
- What does "transparent" mean to him: seeing it himself, or showing it to someone else (a manager, his family)?
- How do priorities and weekly goals get set today, and where do they live?
- Should work and personal life sit in one view, side by side, or stay separate with a shared summary?
- Of the three ticket systems (GitHub issues, Jira, Linear), which should be "the" place for Josh 360's own work, and which stay as outside sources?
- Is Josh 360 something he looks at, something he plans in, or something that nudges him?
- Which existing pieces does he love and want to keep exactly as they are, and which are he tolerating?
- What would make this a failure even if it technically worked (for example, another dashboard he never opens)?
- For consolidation: should josh-360 absorb the code of the other three, or sit on top of them and read their data?
- Should data move off the Mac (for example into Supabase) so it is reachable from a phone or by cloud agents?

## What to hand back at the end

When Josh says he is done, write one summary he can paste into another session. Keep his own words where you can, and mark anything you suggested rather than heard from him. Use these headings:

1. **The vision in a few sentences**, in Josh's words.
2. **Who it serves and when he would use it** (the moments in his week).
3. **Must-haves, nice-to-haves, and things it must not become.**
4. **Work and personal:** how they should relate.
5. **Ticketing:** which system is home, and what the others become.
6. **Consolidation:** what he wants from each of claude-360, claude-harness and action-triage, and whether josh-360 absorbs or sits on top of them.
7. **Data:** any thoughts on where data should live.
8. **Open questions and decisions he has not made yet.**
9. **Anything he said with strong feeling**, quoted.
