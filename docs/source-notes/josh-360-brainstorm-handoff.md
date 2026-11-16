# Josh 360: Brainstorm Handoff

From a voice brainstorm with Josh. This is not a spec. It hands off to a technical session that can read the three repos and is still expected to brainstorm and innovate with Josh. Items marked *(suggested)* came from Claude, not Josh.

## 1. The vision in a few sentences

A personal 360-degree view of "where my brain has been at", since so much of Josh's productive work happens through Claude Code sessions. It works in three layers: big perennial priorities that rarely change, week-to-week priorities (set at the start of the week and added to as things come up), and task and ticket tracking through his agentic coding tools. The core is a missing data layer: "a persistent memory about Josh" and what he works on day to day. Every session logs to "a global ledger", ticket or not, so he can ask what he worked on last week, which sessions left loose ends, which were tied to tickets, and whether "something I promised to somebody" is still outstanding.

Josh 360 should be the home for his DevEx (developer experience) as an ongoing project: where workflow ideas get documented and where improvements land. It should be agnostic to future tools.

## 2. Who it serves and when he would use it

- Josh himself. Roughly 20 to 30 Claude sessions a week, and he's trying to be more disciplined about tickets.
- Start of the week: big priorities visible as "a pervasive signal".
- Any time: a dashboard showing last week visually (what got done, how much, tickets added versus resolved, loose ends). He'll work out the best visualisations later.
- On demand: when he asks "what are my loose ends?", an agent can answer from the ledger.

## 3. Must-haves, nice-to-haves, and things it must not become

Must-haves:

- Every session logs quietly. No forms, gatekeeping or multi-turn setup at the start of a session.
- AI's role is upstream only: codifying sessions into data (what kind of session, what it produced, whether it's finished) for downstream analysis.
- Low or no extra LLM cost. Reuse tokens already being spent, for example the pre-compact step. "I don't want this to be another layer of LLM synthesis and processing and output that I have to pay for."
- Every session linked to something, most specific first: a ticket, then an active epic, then at minimum a perennial priority (which could have its own standing Jira tickets). Done by a helper with little input from Josh. Asks only when it really can't tell.
- No orphan tickets: tickets always tied to a broader project or purpose. Backlog-refinement-style help (catching orphans and duplicates, linking to projects) is welcome if it runs without much input.

Ideas from the MOSAN paper (Sagnelli et al. 2026) that Josh wants to apply:

- One shared, append-only ledger instead of long accumulating context.
- Keep facts separate from planning.
- End-of-cycle summaries that seed what comes next.
- The spirit of building memory up over time while fighting context rot and context bloat.

Must not become:

- A scheduled routine or auto-generated report. No agent that synthesises his priorities or "keeps me on task".
- An automated critic running in the background. He wasn't convinced by MOSAN's critic.
- A framework he has to keep in mind at every task. On busy days he multitasks, skips the system, ends up "in debt" to it, and asks "why even try the next day".
- Another repo he moves on from: Agent Command Center, then action-triage, then Claude 360 didn't stick, partly because UI/UX came before a solid workflow and priority framework. Data and framework first, not new app features.

## 4. Work and personal

Both belong on the dashboard, clearly delineated. He doesn't do much personal work on his work laptop and accepts that personal work may be split across two places for now.

## 5. Ticketing

- GitHub issues are out. Jira is for work and Linear is for personal.
- Jira boards include Josh Projects, Application Development and Clinical Informatics.
- The newer action-triage has already replaced all GitHub-issue functionality with creating and processing Jira tickets. Work from that version.
- Jira, Linear, agent coding sessions and CLI tools are extensions connected to Josh 360, not the platform itself. The platform doesn't stand on its own without them.
- Ticket conventions across spaces, boards and Linear should be reviewed and defined in Josh 360's documentation, not just accepted as deliberate because they exist today.

## 6. Consolidation

- josh-360 absorbs the code of action-triage and claude-360 (Session Atlas). Both become redundant once Josh 360 is complete.
- claude-harness (\~/.claude) probably stays separate. It holds the personal-workflow skills that use and maintain Josh 360, and those skills are thoroughly documented in josh-360 so they're portable.
- The separate local databases get unified into one relational schema under Josh 360, and the session ledger is built on top.

## 6b. Agent graphs and the wider workflow

Josh 360 is the hub and data foundation for how Josh gets work done. That means coding sessions and CLI tools, ticketing systems, and above all how the two interact, which is where much of his harness work has gone. From here on everything should be tool-agnostic.

- Today he uses Agent Manager, a terminal tool for organising CLI agent sessions, to build simple agent graphs. A coordinator agent he talks to creates and prompts a Jira worker session. The worker reports back to the coordinator as it moves the ticket through its Jira states.
- The goal on a granular level: "create tickets, hand off tickets to my agentic assistant pipeline" and have them move through the agent graph to completion "without unnecessary bottlenecking the process on my input."
- Josh 360 should be the memory layer that fuels these graphs.
- He has unimplemented agent-graph ideas from other brainstorm sessions, including triaging Jira tickets and handing them off to the right graph. He can bring that context to the next session.
- Even if the first phase doesn't build agent graphs, whatever gets built should keep them in mind. "There's big ideas here."

Open for the technical session: what the ledger must hold and expose for agent graphs (coordinator, worker, triage) to run with little input from Josh, without being tied to Agent Manager specifically.

## 7. Data

- Local only. No cloud database for now.
- The ledger doubles as persistent project memory: a new session in a project folder can draw on how work has gone over time.
- Sessions pull small, targeted answers. Never the full transcript, and no flooding new sessions with past context.
- The ledger should replace per-project changelog.md files, which create merge conflicts across PR branches but have been a useful deliberate log.

## 8. Open questions for the technical session

- What exactly gets logged about each session, qualitatively, so later questions can be answered without reading transcripts?
- How can logging reuse existing token spend (pre-compact hooks, session-focus notes, Atlas focus summaries) rather than add new LLM calls?
- How do new sessions query the ledger cheaply and in small pieces?
- Is the ticket-matching helper a sub-agent per session or one ever-present agent that sessions check in with?
- How do we avoid drowning in tickets (volume, duplicates, organisation) while working almost exclusively in tickets?
- What should the Jira and Linear conventions be (boards, epics, standing tickets for perennial priorities), and how do they line up with the priority layers?
- Where do perennial and weekly priorities live, and how are they edited? *(suggested: a simple human-edited file, as in MOSAN's directive file)*
- What do the dashboard visualisations look like? Josh deferred this.
- What exactly carries over from action-triage and Claude 360, and what gets dropped?
- How do work and personal stay delineated across two machines?

## 9. Said with strong feeling

- "I'm not ready for this to block."
- "I'm not wanting an AI agent to sort of keep me on task."
- "I don't want this to be another layer of LLM synthesis and processing and output that I have to pay for."
- "Why even try the next day to pick it back up if I'm already in debt to this framework."
- "Let's try to fight against context rot. Let's try to fight against context bloat. Let's try to let this harness not get out of control."
- "Tickets as a unit of work is a great idea."
