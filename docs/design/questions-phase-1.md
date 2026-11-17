# Phase 1 design questions (JP-106)

## Contents

- [How to answer](#how-to-answer)
- [The questions, most work unblocked first](#the-questions-most-work-unblocked-first)
- [Already answered or settled, so not asked](#already-answered-or-settled-so-not-asked)
- [Where the questions came from](#where-the-questions-came-from)
- [Answers](#answers)

## How to answer

Fourteen questions, collected from the two inventories (JP-96, JP-97), the conventions ticket (JP-98) and the four designs (JP-99, JP-102, JP-103, JP-104). Repeats are merged, and anything already decided in `docs/decisions.md` or the vision is left out (listed at the end, so you can see why).

Each question says where it came from, gives one example, lists the options with what each does and its risk, and gives a recommendation. Pick an option, or write your own answer. "Take every recommendation" is a valid answer for the whole page.

Every build is already running on the recommended option, so nothing is waiting except JP-107, which waits for this sitting. Every answer can be changed later; none deletes anything.

The order is by how much work each answer unblocks: the ledger first (JP-107 blocks the walker, JP-114, and so most of phase 1), then priorities, then the graphs built in phase 2, then the laptop clean-up that phase 1's close (JP-120) carries out.

## The questions, most work unblocked first

### Q1. One ledger file or two?

**Unblocks:** JP-107 (the ledger), and through it JP-108 to JP-117. **From:** JP-99, `docs/design/data-model.md`.

**Context.** The ledger is the one local database that records every session, graph run and decision. Some of what goes in it is small and kept for ever (one row per session: its cost, its ticket, its summary). Some is big and can be rebuilt from the transcripts at any time: the cost importer's row for every single model message (about 0.6 GB today), and Session Atlas's file catalog. Example: re-pricing last month's sessions after a price change rewrites thousands of message rows, which the "rows are only ever added" rule forbids.

| Option | What happens | Risk |
| --- | --- | --- |
| **A. Two files (recommended).** | `ledger.db` holds the facts, append-only, about 60 MB a year, backed up daily. `cache.db` holds the big rebuildable tables. | Two files to know about. A query that needs both opens both. |
| B. One file. | Everything in `ledger.db`. | Backups about ten times larger, and an exception to the append-only rule so the cost import can re-price. |

**Recommendation: A.** The small file is the one worth protecting; the big one can always be rebuilt.

### Q2. May the ledger keep any of your own words?

**Unblocks:** JP-107 and JP-108 (the five summary lines). **From:** JP-99, question 2.

**Context.** The vision says each session's five-line summary is built from its title, your first message and its STATE.md. JP-108's acceptance criteria say no field stores message text. The two disagree. Example: a session that was only a question ("what does the PIMS export job do?") has a generic title and a thin STATE.md, so without your first line the summary says little.

| Option | What happens | Risk |
| --- | --- | --- |
| **A. No copied words (recommended).** | The summary comes from the title and STATE.md. Only when those are too thin does one small model call write the "what was asked" line, in its own words. Every short text passes the patient-data check and has a length cap. | One small model call for thin sessions (question-only ones mostly). |
| B. Keep your first line. | Copy the first 160 characters of your first message, after the same patient-data check. | Your words sit in the ledger for ever; a patient detail the check misses stays there too (it can be withdrawn, but only once noticed). |

**Recommendation: A.** It keeps the "no patient data in the ledger" rule simple, at the cost of a rare small model call.

### Q3. How long are things kept, and where are the backups?

**Unblocks:** JP-107 (backups) and JP-111 (moving Atlas onto the ledger). **From:** JP-99, question 3.

**Context.** The ledger is the long-term record, so losing it loses the history every measure depends on. Example: the laptop disk fails; with laptop-only backups the history is gone with it.

| Option | What happens | Risk |
| --- | --- | --- |
| **A. Laptop only (recommended for now).** | `ledger.db` kept for ever; 14 daily and 8 weekly compressed backups on the laptop. The per-message cost rows in `cache.db` are removed 90 days after each session's cost is copied into the ledger. | A lost or broken laptop loses the history. |
| B. A plus a copy off the laptop (OneDrive). | Same, plus each daily backup is copied to OneDrive. | The vision deferred "moving data off the laptop"; it needs a check that no patient data can reach the copy (the ledger should hold none). |
| C. A, but keep the per-message rows for ever. | Nothing is removed from `cache.db`. | About 0.6 GB now and growing. |

**Recommendation: A**, with B as its own ticket once the ledger has run for a while. Tell me if the history matters enough to you to do B now.

### Q4. What is one "category" of question, for the three stages of decision memory?

**Unblocks:** JP-107 (the column's meaning), JP-116 (stage one) and JP-126 (stage two). **From:** JP-99, question 4.

**Context.** Every question an agent asks you is saved with your answer. You move a whole category of question through three stages yourself: stage 1 always asks you, stage 2 suggests an answer from your past ones and you confirm, stage 3 answers from precedent and tells you. The question is how big a category is. Example: the triage graph's "this ticket is missing something only you know" question, asked about tickets for Athena, EQuIP and josh-360.

| Option | What happens | Risk |
| --- | --- | --- |
| A. One category per asking step. | `triage/ask_josh` is one category. You promote "the triage questions" in one move. A lookup still only uses past answers for the same system and type of work. | You cannot promote it for josh-360 while keeping it at stage 1 for Athena. It also lumps together the approval card's categories, which the approved ticket creation design splits by system, ticket type, shape and action. |
| B. One category per asking step and system. | `triage/ask_josh` for Athena and for josh-360 are separate. | Many more categories to manage; each needs your own move. |
| **C. One category per asking step, split further where the step says so (recommended).** | By default a step is one category, as in A. A step may name the details that split it: the approval card splits by system, ticket type, shape and action, as its approved design (JP-102) already says. | A step's split is written in its graph file, so changing it is a small graph change. |

**Recommendation: C** (added 16 November after Josh asked what Q4 covers, because A conflicts with the approved approval-card design). Few moves for you where a step's questions are alike, and finer control where a wrong guess is costly, such as tickets on team boards.

### Q5. Which of your six do these systems fall under?

**Unblocks:** JP-107 (each session is filed under a priority from day one), the weekly review (JP-127) and the dashboard (JP-130). **From:** JP-98, `conventions/registry.yaml`.

**Context.** Every session is filed under one of your six accountabilities (Athena, EQuIP, PIMS, M&A clinical data transfer, Clinician tech stack and UX, AI scribing utilization), DevEx, or Unassigned. That is how "time outside the six" gets counted. Six systems had no clear owner in Jira, so they were left Unassigned rather than guessed: Charta services, Survey services, Training services, the Azure Functions app for the clinical applications (`fx-app-apps-services`), Zus enrollment and data exchange (`fx-app-zus-services`) and the Azure Synapse pipelines. Example: an afternoon fixing a Synapse pipeline would count as outside the six.

| Option | What happens | Risk |
| --- | --- | --- |
| **A. Leave them Unassigned (recommended unless you know better).** | Their sessions count as outside the six. | If one really serves, say, Athena, your Athena time is under-counted. |
| B. Tell me which priority each one serves. | I update the registry; sessions file there from then on. | None. |

**Recommendation:** answer in your own words for any you know (for example "Zus is M&A, Synapse is Athena"); the rest stay Unassigned.

### Q6. What do PIMS, M&A clinical data transfer and AI scribing utilization cover in Jira?

**Unblocks:** the same as Q5. **From:** JP-98, `conventions/priorities.yaml`.

**Context.** A ticket's priority comes from its epic, then the initiative its epic relates to, then its area. Athena, EQuIP, Clinician tech stack and DevEx each have epics or initiatives mapped to them. PIMS, M&A clinical data transfer and AI scribing utilization have none yet, because no open epic in AD or CI, or initiative in TECH, clearly belongs to them. Example: a ticket under an AI scribing epic would file as Unassigned today.

| Option | What happens | Risk |
| --- | --- | --- |
| **A. Leave them empty for now (recommended unless you know better).** | Their tickets file by system instead (the PIMS services and AI scribing services systems already point at them). | Tickets in other systems that serve them count as Unassigned. |
| B. Name the epics or initiatives. | I add them to `priorities.yaml`. | None. |

**Recommendation:** name any epics or initiatives you know; otherwise A.

### Q7. Should the action-triage daemon start the walker's headless sessions?

**Unblocks:** JP-117 (binding the walker to Agent Manager), JP-124 (moving action-triage in) and JP-128 (retiring the sprint skill). **From:** JP-97, `docs/inventory/features.md` question 3.

**Context.** Two things can start a session for a Queued ticket. action-triage's daemon already can (Jira pickup, built but switched off), with its watchdog, token handling and safety rails. The walker (JP-114) will name the next step of a graph, and JP-117 has Agent Manager start that step's session. Example: a development ticket is Queued at 2 AM; something has to start the designer session without you.

| Option | What happens | Risk |
| --- | --- | --- |
| **A. One pickup: the daemon asks the walker (recommended).** | The daemon finds Queued tickets, asks the walker which step is next, and starts the session the walker names. Agent Manager stays the way you watch and join sessions. | The daemon has to learn the walker's question-and-answer, a change in action-triage (it waits for a phase close like every PR there). |
| B. Two pickups. | The daemon runs its own sessions; the walker runs graphs through Agent Manager. | Two ways to start work on a ticket, which the vision set out to remove; the same ticket could be started twice. |
| C. Agent Manager only. | The daemon's pickup is retired. | Headless runs lose the daemon's watchdog and token refresh, which would need rebuilding. |

**Recommendation: A.** The graph stays independent of the tool that runs it, and headless runs keep the safety rails already proven.

### Q8. Which new tickets come to you on the approval card?

**Unblocks:** JP-121 (the ticket creation graph). **From:** JP-102, `docs/design/ticket-creation-graph.md`.

**Context.** You already decided that you approve the shape of a parent and its children before anything is created. The open part is single tickets. A ticket in AD or CI appears on a team board, so the graph rules count creating it as a write to something shared, which needs your yes. Note: when you approved the triage design (JP-103), you accepted that moving your own tickets in AD or CI to Ready counts as your own write, not a shared one. Option C applies that same rule to creating them. Example: you forward an email asking for an Athena report fix; the graph drafts one AD ticket.

| Option | What happens | Risk |
| --- | --- | --- |
| **A. Every input gets one card at first (recommended).** | One tap per input, whatever the space. The card relaxes by category as decision memory moves it to stages 2 and 3. Works with the graph checker as built. | More taps in the first weeks. |
| B. Cards for parents with children and for AD or CI tickets only. | A single JP ticket is written without a card. | Needs a change to the checker's shared-write rule so an approval can be skipped. |
| C. Cards for parents with children only. | A single ticket you file in AD or CI counts as your own write, as triage already treats it. | A badly drafted ticket can land on a team board without you seeing it first. |

**Recommendation: A.** Creating is the moment something first appears on a team board, and the taps shrink by themselves through decision memory. C is the consistent choice if you would rather not tap for single tickets.

### Q9. Where do meeting action items go once the Calendar tab retires?

**Unblocks:** JP-121 and JP-124. **From:** JP-97, question 2.

**Context.** action-triage pulls your Notion meeting notes and asks a small model for each meeting's action items, which today appear on its Calendar tab (draft a ticket, mark done, snooze, dismiss). The approved console redesign removes that tab without saying where the items go instead. Example: "Josh to send the EQuIP payout numbers to finance" from Tuesday's meeting.

| Option | What happens | Risk |
| --- | --- | --- |
| **A. Keep the tab until the ticket creation graph exists (recommended).** | Once JP-121 is built, each extracted item becomes a proposed ticket through that graph (Notion is in its second wave, filtered because it is the noisiest source), and then the tab retires. | Notion items wait until phase 2 to become tickets. |
| B. Retire the tab now. | Items stay in the extraction file until JP-121 reads them. | Nothing shows them to you for a while. |
| C. Stop extracting meeting action items. | The extraction job retires. | Commitments made in meetings are captured only by hand. |

**Recommendation: A.**

### Q10. Keep the Obsidian wiki?

**Unblocks:** JP-120 (phase 1's archive list). **From:** JP-96, `docs/inventory/laptop.md` question 2.

**Context.** The wiki is a knowledge base with twelve skills (ingest, query, lint and so on). Its old transcript-staging hook is already unwired and is being retired either way, because the ledger keeps pointers to transcripts instead of copies. The laptop run found no wiki skill called in about seven weeks and nothing added to its staging folder since 5 May.

| Option | What happens | Risk |
| --- | --- | --- |
| **A. Keep the wiki and its skills (recommended if you still use it).** | Only the staging hook and its 1.1 GB of transcript copies retire. | Twelve skills you may not use stay in every session's list. |
| B. Archive the wiki skills too. | The skills move to the archive at phase close; the vault itself is untouched. | If you go back to it, the skills come back from the archive in one move. |

**Recommendation:** A if you still open the wiki, otherwise B. The usage data points to B.

### Q11. Do you still use OpenCode directly?

**Unblocks:** JP-120. **From:** JP-96, question 3.

**Context.** OpenCode is a second coding client. action-triage uses it as its chat engine, and an hourly job copies your Claude agents into OpenCode, but those copies point at model routes that were retired, so they cannot run.

| Option | What happens | Risk |
| --- | --- | --- |
| **A. Retire the hourly agent sync; keep OpenCode for action-triage (recommended).** | The sync job is switched off and archived. | If you use OpenCode by hand, its agents stay broken until fixed by hand. |
| B. Keep using it by hand, and fix the sync. | The sync's model map is updated to Bifrost names. | Upkeep for a client you may not use. |

**Recommendation: A**, unless you use OpenCode yourself.

### Q12. Retire the leftover tools?

**Unblocks:** JP-120. **From:** JP-96, question 4.

**Context.** Five tools each duplicate something Agent Manager, Claude Code or Jira already does: QuickTasks (already gone from the laptop), Omnara (a remote-control app, still running), the agent-deck hooks (7 events in every session), the "Tactic Remote" hooks (5 events, including every tool call) and the task-manager to-do queue on OneDrive (last used 1 October).

| Option | What happens | Risk |
| --- | --- | --- |
| **A. Retire all five (recommended).** | Switched off and archived at phase close. | If one is still in daily use, you lose it until it is put back. |
| B. Keep some. | Name the ones you still use. | None. |

**Recommendation: A**, unless you name one you use.

### Q13. Do you still want the rclone backup of `~/josh_personal`?

**Unblocks:** JP-120, or a new laptop job. **From:** JP-96, question 7.

**Context.** A job called `com.jgilpatrick.rclone-sync` once copied `~/josh_personal` to Google Drive every 30 minutes. The laptop run found it is not installed, so that folder is not being backed up by it today.

| Option | What happens | Risk |
| --- | --- | --- |
| **A. Yes, bring it back as a josh-360 laptop job (recommended if you want the backup).** | Added to `jobs.yaml`, so it installs from `main` and reports its status like every job. | It needs the rclone setup still on the laptop; the job reports if it is not. |
| B. No. | Marked dismantle. | The folder has no backup from this job. |

**Recommendation: A** if the folder matters to you; I cannot tell from here whether something else already backs it up.

### Q14. Archive the 131 skills nobody used?

**Unblocks:** JP-120. **From:** JP-96, question 8.

**Context.** 131 of your skills had no call in about seven weeks of session records (the list is the appendix of `docs/inventory/laptop.md`). Every installed skill adds a line to every session's skill list.

| Option | What happens | Risk |
| --- | --- | --- |
| **A. Archive them, except any a rule or another skill names (recommended).** | For example `bulk-email-safety` (your global rules) and the `principle-*` set (`poteto-mode` reads them) stay; the rest move to the archive at phase close. | A rarely used skill is missed; it comes back from the archive in one move. |
| B. Keep them all. | Nothing changes. | The skill list stays long. |
| C. Let me pick. | You mark the ones to keep. | Your time. |

**Recommendation: A.**

## Already answered or settled, so not asked

| Question | From | Why it is not asked |
| --- | --- | --- |
| Retire Session Atlas's per-turn summaries? | JP-96 Q1 | You accepted it on 15 November ("The nine items", item 1). |
| Retire the focus loop in favour of STATE.md? | JP-96 Q5 | The vision you approved keeps STATE.md as the one session record; JP-100 is doing it. |
| Which copy of the six Paseo skills is the real one? | JP-96 Q6 | The two copies are byte-identical, so nothing is lost either way. Your global rules list `~/.claude/.agents/skills/` as the home of the `paseo*` folders, so that copy stays and the one in `skills/` is archived at phase close (reversible). |
| Who reviews josh-360 pull requests? | JP-97 Q1 | You chose your laptop's audit on 16 November (JP-141). |
| Do action-triage tickets go to JP? | JP-98 Q3 | You decided on 15 November that DevEx work is ticketed in JP. Existing AD tickets stay where they are. |
| Branch names `KEY/slug` or `KEY-slug`? | JP-98 Q4 | Both are accepted (the key comes first either way), which changes nothing that exists. Recorded in `docs/decisions.md`; say so if you want one. |
| Are the registry's folder paths right? | JP-98 Q5 | A fact to check on the laptop, not a choice for you. A wrong path is corrected in the registry when it is found (`docs/decisions.md`, JP-98). |
| Triage's four questions (which tickets it may write, sign-off tier, drafter rounds, test tags everywhere) | JP-103 Q1 to Q4 | Your approval of the triage design on 16 November took the recommended option for each; now recorded in `docs/decisions.md`. |
| Does the non-development graph replace the desk's worker? Does every deliverable wait for sign-off? | JP-104 Q1, Q2 | You answered both on 16 November. |
| Which version does a run record? | JP-140 | Settled by the data model: it records both the graph file's commit and the repository's commit. |

## Where the questions came from

| Source | Where its questions are | In this page |
| --- | --- | --- |
| JP-96 laptop inventory | `docs/inventory/laptop.md`, "Questions for the phase 1 sitting" (8) | Q10 to Q14; three settled |
| JP-97 feature inventory | `docs/inventory/features.md`, "Questions for Josh" (3) | Q7, Q9; one answered |
| JP-98 conventions | Comment on JP-106; rows in `docs/decisions.md` (5) | Q5, Q6; three settled |
| JP-99 data model | `docs/design/data-model.md`, "Questions for Josh" (4) | Q1 to Q4 |
| JP-102 ticket creation | `docs/design/ticket-creation-graph.md`, "Question for Josh" (1) | Q8 |
| JP-103 triage | `docs/superpowers/specs/2026-11-16-triage-graph-design.md` (4) | All answered |
| JP-104 non-development | `docs/design/non-development-graph.md` (2) | All answered |

## Answers

Josh answered on the answer page on 16 November 2026 at 7:26 PM. Each answer is recorded in `docs/decisions.md` and written into the design it came from.

| # | Answer | What changes | Written into |
| --- | --- | --- | --- |
| Q1 | A, two files | Nothing; the design already had two. | `docs/design/data-model.md` |
| Q2 | B, keep the first line of the first message | A summary line may copy it, 160 characters at most, after the patient-data check. | `docs/design/data-model.md` (JP-108 builds the summary) |
| Q3 | A, plus an off-laptop copy | Backups as recommended, and each copy also goes to an Azure blob storage container, not OneDrive. | `docs/design/data-model.md` |
| Q4 | C, the asking step, split on the details it names | The approval card splits by system, ticket type, shape and action. | `docs/design/data-model.md` (JP-114, JP-116) |
| Q5 | Josh's own mapping | Charta goes under EQuIP. The shared function app and Zus go under a new seventh accountability, Internal Systems & Applications. Survey and Training stay Unassigned on purpose. Synapse stays Unassigned. | `conventions/registry.yaml`, `conventions/priorities.yaml` |
| Q6 | B, new epics in CI | The new epics are created in CI. Creating them is a write to a team board, so it waits for Josh's yes on the epic list in the JP-106 thread, and the department convention says an epic has an end. | `conventions/priorities.yaml` once the epics exist |
| Q7 | Yes (A) | A daemon watches Jira for tickets in a given state and launches the graph when the conditions are met, for example a Ready ticket not in the backlog goes through triage. | `docs/inventory/features.md` (JP-114, JP-120) |
| Q8 | A, every input gets one card at first | Nothing; the design already did this. | `docs/design/ticket-creation-graph.md` |
| Q9 | A, but the Calendar tab stays | Josh has not agreed to retire the Calendar tab. Items also flow to the ticket creation graph once it exists. | `docs/inventory/features.md` (row A3) |
| Q10 | B, archive the wiki and its skills | Archived, not deleted. | `docs/inventory/laptop.md` |
| Q11 | Josh still uses OpenCode | The OpenCode agent sync stays, gets Bifrost model names, and runs when the agents folder changes instead of hourly. | `docs/inventory/laptop.md` |
| Q12 | B, with detail | Omnara is disconnected; the Tactic Remote hooks and the task-manager queue retire; QuickTasks is already gone and "quick tickets" is noted as an idea. agent-deck waits for the feature-tree review Josh asked for, which covers every feature in claude-360, action-triage and macbook-automations. | `docs/inventory/laptop.md` |
| Q13 | B, no rclone backup | The rclone row retires. | `docs/inventory/laptop.md` |
| Q14 | C, Josh picks | Josh picked them: 67 kept (including three that kept skills depend on), 64 archived at the phase close. | `docs/inventory/laptop.md` (appendix) |

Josh also said, in his Q12 note, that action-triage, claude-360 and the related MacBook automations are to be melded into one application, josh-360: the features he keeps are extracted from their source repositories and rebuilt into one platform with a consistent look, not linked or nested. That direction shapes the feature-tree review and every migration ticket.
