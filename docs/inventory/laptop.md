# Work laptop inventory

## Contents

- [What this file is](#what-this-file-is)
- [Answers to the ticket's questions](#answers-to-the-tickets-questions)
- [How to read the tables](#how-to-read-the-tables)
- [Background jobs](#background-jobs)
- [Hooks](#hooks)
- [Plugins and MCP servers](#plugins-and-mcp-servers)
- [Memory and transcript readers](#memory-and-transcript-readers)
- [Data stores](#data-stores)
- [Agent definitions](#agent-definitions)
- [Skills](#skills)
- [Tools and scripts](#tools-and-scripts)
- [Dismantling plan](#dismantling-plan)
- [Questions for the phase 1 sitting](#questions-for-the-phase-1-sitting)
- [What the laptop run adds](#what-the-laptop-run-adds)
- [Appendix: skills and agents with no recent use](#appendix-skills-and-agents-with-no-recent-use)

## What this file is

Every background job, hook, data store, skill, agent definition and memory mechanism on Josh's work laptop, each with one verdict and a reason (JP-96). It was written in the cloud from four repositories: claude-harness (Josh's `~/.claude`), macbook-automations, claude-360 (Session Atlas) and action-triage, plus the harness's own storage register of 8 November 2026 (`docs/harness/state-stores.md` and its siblings in claude-harness).

What only the laptop can say (which jobs are loaded, current sizes, when each thing last ran, which skills and agents were used) comes from the one read-only script, `scripts/laptop_inventory.py`. The laptop ran it once on its own on 16 November 2026, as the JP-105 job `inventory`, and its report is on the `laptop-status` branch as `reports/inventory.json`. Its answers fill the "Last used" column and the sizes below; verdicts it contradicted were changed, and each such row says so. See [What the laptop run adds](#what-the-laptop-run-adds).

The features of action-triage and Session Atlas have their own ticket (JP-97). Here they appear only as jobs, hooks and stores. Nothing is switched off by this ticket.

## Answers to the ticket's questions

**Which background jobs are still needed, and which belong to retired tools?** The vision counted about twenty. The repositories and the laptop run (16 November 2026) together name 32 launchd jobs or job templates of Josh's own; third-party updaters and agents (Microsoft, Zoom, Docker and the like) are left out. Sixteen stay as they are (personal chores, work pipelines, the login startup list, Agent Manager, Josh 360's own job runner). Five move into josh-360 with action-triage and Session Atlas. Ten belong to retired tools or to tools the ledger replaces and are dismantled. Five of those ten are already gone from the laptop: the Agent Command Center server, the claude-mem worker, QuickTasks, the meeting watcher and fcc-server. Five still run or sit installed: the old focus dashboard, the QA waker watchdog, the OpenCode agent sync, Omnara, and a ClickUp to Notion sync that is installed but not loaded. One more, the sprint watchdog, is built new as part of the development graph. See [Background jobs](#background-jobs).

**Are claude-mem and the Obsidian transcript staging kept, replaced by the ledger, or dismantled?** Both are dismantled. claude-mem is already switched off in the live settings (16 cached versions remain), and the Obsidian staging hook is not wired in either settings file. The ledger keeps a pointer to each transcript instead of a copy, so neither is needed. The laptop run found 4.5 GB in `~/.claude-mem` and 1.1 GB of transcript copies in the staging folder, both untouched since September and May. The Obsidian wiki itself and its skills are kept for now, though none of the wiki skills was called in the window (question 2). Session Atlas moves onto the ledger (JP-111), its per-turn summary worker is retired, and the dormant context-mode databases are archived. That leaves one reader of transcripts, the ledger. See [Memory and transcript readers](#memory-and-transcript-readers).

**Which skills and agent definitions show no recent use?** 131 of the 219 skills and 18 of the 38 agent definitions (3 of them Codex profiles, which Claude Code never calls) had no call in the window. The counts cover every Skill call, slash command and agent call the laptop's transcripts hold from 18 August 2026, but few transcripts from before 28 September survive, so the real window is about seven weeks. Full lists are in the [appendix](#appendix-skills-and-agents-with-no-recent-use). Five agents with no caller and no call are now dismantled; the unused skills are put to Josh as question 8.

**What are the starting figures?** In `docs/inventory/starting-figures.md`: about 61 sessions a week (103 a week over the seven weeks with full records), a median of 4 messages from Josh per interactive session, 51% of sessions tied to a ticket, and 1,011 open loose ends (974 on the laptop's git, 18 open pull requests, 19 tickets in flight).

## How to read the tables

Each row has exactly one verdict:

- **keep**: stays as it is, where it is.
- **migrate**: moves into josh-360, or onto the ledger, with the ticket named in the reason.
- **build new**: a josh-360 piece replaces it; the old one runs until the new one is proven.
- **dismantle**: switched off and archived (reversible, needs nobody). Anything that would later be deleted for good goes on the deletion list for the phase close (JP-120).

"Started by" is what makes it run. "Last used" is a date from the storage register where one exists, otherwise the field of the laptop run that answers it. Paths are under `~` (`/Users/jgilpatrick`).

## Background jobs

Six start from the macbook-automations startup list; the rest are installed by their own projects.

| Item | What it is | Started by | Reads and writes | Last used | Verdict | Reason |
| --- | --- | --- | --- | --- | --- | --- |
| `com.jgilpatrick.startup` | The one login job; loads every plist in `launchd/startup-manifest.txt` | launchd at login | Reads the manifest; loads jobs | loaded; ran at login, exit 0 | keep | The vision reuses this list for every Josh 360 job (JP-105, JP-119). |
| `com.jgilpatrick.automations-hub` | Receipt watcher: names and files receipts with a Claude call | startup list, always on | `receipts/receipt_inbox/`; writes `receipts/` | loaded, running | keep | A personal chore outside the agent workflow. |
| `com.jgilpatrick.outlook-receipt-fetcher` | Weekly Outlook receipt sweep | startup list, Fridays 5 PM | Outlook `Receipt` folder; writes `receipt_inbox/` | loaded, exit 0 | keep | Personal chore. |
| `com.jgilpatrick.claude-transcript-scrubber` | Gitleaks scan that redacts secrets in transcripts | startup list, daily | Reads and rewrites `~/.claude/projects/**/*.jsonl` in place | loaded, running; its state file changed 2026-11-13 | keep | It removes secrets rather than keeping a memory, so it is not a fourth reader; the ledger keeps pointers, so redaction stays useful. |
| `com.jgilpatrick.idemeum-log-retention` | Deletes Idemeum logs over 24 hours old | startup list, daily 03:17 | Idemeum log folder | loaded, exit 0 | keep | Machine hygiene. |
| `com.jgilpatrick.agent-manager` | Starts Agent Manager in tmux at login | startup list, at login | Agent Manager's own state | loaded, exit 0 (it starts tmux and exits) | keep | The graphs bind to Agent Manager first (JP-117). |
| `com.jgilpatrick.sync-opencode-agents` | Copies `~/.claude/agents` into OpenCode agents | startup list, hourly | `~/.claude/agents`; writes `~/.config/opencode/agents` | loaded, exit 0 | keep | Josh still uses OpenCode directly (JP-106, Q11). Its model map still targets `litellm/...`, which was retired, so it is fixed to Bifrost model names and runs when `~/.claude/agents` changes instead of hourly, as the skill sync does. |
| `com.jgilpatrick.sync-client-skills` | Keeps skill links for OpenCode, Pi and Codex | its own plist, when `~/.claude/skills` changes | `~/.claude/skills`; writes links in `~/.opencode`, `~/.pi`, `~/.codex` | loaded, exit 0; log 2026-11-16 (551 KB) | keep | Josh's global rules keep one skill store linked into each client. |
| `com.eventus.action-agent` | action-triage orchestrator: picks up work, runs sessions and PR audits | own plist, always on | GitHub, Jira, transcripts in place; writes `~/Library/Application Support/action-agent/` | loaded, running; log 2026-11-16 (7.1 MB) | migrate | Moves into josh-360 with action-triage (JP-124). |
| `com.eventus.action-triage` | action-triage desktop app | own plist, at login | Many stores read-only; writes its app folder and logs | loaded, running; error log 2026-11-09 | migrate | Moves with action-triage (JP-124). Which of its two plist forms is installed is a laptop-run fact. |
| `com.eventus.desk-watcher` | Email Research Desk: hands new emails to the desk coordinator each minute | own plist, every 60 s (loaded at cutover) | Email log endpoint; writes `desk.db` | loaded, exit 0; log 2026-11-05 | migrate | Part of action-triage's intake; moves with it (JP-124). |
| `com.eventus.claude-atlas` | Session Atlas service: dashboard on port 8770 and nine runners | own plist, always on | Transcripts in place, hook events; writes `~/.claude/atlas/`, `~/.claude/cost-ledger/` | loaded, running; plist changed 2026-11-16 | migrate | Moves into josh-360 and onto the ledger (JP-111). |
| `com.eventus.meetings-sync` | Pulls meetings from Notion every 15 minutes and extracts action items | Agent Command Center's plist | Notion; writes `action-items.json` and meeting files | loaded, exit 0; log 2026-11-16 | migrate | Runs Agent Command Center's copy of the script while action-triage holds the maintained copy; repoint it when action-triage moves (JP-124). |
| `com.eventus.meeting-watcher` | Triggers the Notion sync when a meeting ends | Agent Command Center's plist | Meeting state | not on the laptop (no plist, not loaded) | dismantle | Already gone, so there is nothing to move; action-triage's trigger server takes the meeting-ended nudge. Changed from migrate by the laptop run. |
| `com.eventus.acc-launch-spawner` | Agent Command Center Node server | Agent Command Center's plist | Its own data | not on the laptop (no plist, not loaded) | dismantle | Command Center is retired and this job is already gone; only its data folder is still used, and that moves with JP-124. |
| `com.eventus.athena-pipeline` | Nightly 2 AM Athena PM pipeline | athena_transition project | Athena data | loaded; last run ended with exit 2; log 2026-11-16 | keep | Work pipeline for an accountability, not agent plumbing. Its last run failed: see "What the laptop run adds". |
| `com.eventus.azure-batch-spend-alert` | Daily 8 AM Azure spend alert | own plist (script not in any repo here) | Azure cost APIs; sends email | loaded; last run ended with exit 1; error log 2026-11-16 | keep | A work alert. Its script is not in a repository. Its last run failed: see "What the laptop run adds". |
| `com.eventus.focus-dashboard` | Focus dashboard on port 8765 | own plist | `~/.claude/session-focus/`, transcripts | loaded, running on port 8765; no log file | dismantle | The focus hooks are not wired live, and STATE.md plus the ledger replace focus files (JP-100). Switched off and its plist archived by the one-time job `retire-focus-dashboard` (JP-100, `jobs.yaml`). |
| `com.jgilpatrick.claude-mem-worker` | claude-mem indexing worker | own plist | Transcripts and tool events; claude-mem's store | not on the laptop (no plist, not loaded) | dismantle | Already gone; the plugin is off in live settings and the ledger replaces it. Its 4.5 GB data folder remains (Data stores). |
| `com.eventus.qa-waker-watchdog` | Watchdog copied from a QA sprint waker | own plist | Waker heartbeat | loaded; last run exit 1; log 2026-10-15 | dismantle | Left over from one QA sprint. |
| `com.jgilpatrick.sprint-waker-<slug>` | Per-sprint watchdog for the sprint waker | `sprint.py install-watchdog` | Heartbeat file; desktop notice | one loaded (`sprint-waker-sprints`), exit 0; log 2026-11-08 | build new | The sprint skill runs until the development graph and walker replace it (JP-115, JP-128). |
| `com.jgilpatrick.notion-skill-sync` | Planned job that publishes skills to Notion | own plist, if built | Skills; Notion | not on the laptop | keep | Planned on 6 November 2026 and not built; outside Josh 360, so nothing to do here. |
| `com.jgilpatrick.rclone-sync` | Syncs `~/josh_personal` to Google Drive every 30 minutes | own plist | Personal folder | not on the laptop (no plist, not loaded) | dismantle | Josh does not want it back (JP-106, Q13). |
| `com.josh.outlook-watchdog` | Keeps Outlook running | own plist | Outlook process | loaded, running | keep | The desk mailer and receipt fetcher need Outlook. |
| `com.josh.quicktasks` | QuickTasks web app | own plist | Its own task store | not on the laptop (no plist, not loaded) | dismantle | Already gone. One more task list beside tickets, Linear and the task-manager queue. |
| `com.omnara.daemon` | Omnara third-party remote-control daemon | own plist | Omnara's own data | loaded, running on port 36673; log 2026-11-16 (5.8 MB) | dismantle | Claude Code's own remote control and Agent Manager cover it. Question 4. |
| `homebrew.mxcl.postgresql@14` | Local PostgreSQL 14 | Homebrew services | Local databases | loaded, running on port 5432; log 2026-11-09 | keep | A development database, not part of the agent workflow. |
| `com.jgilpatrick.josh-360-jobs` | Josh 360's job runner (JP-105) | JP-105's install, every 5 minutes | `~/.josh-360/`; publishes to the `laptop-status` branch | loaded, running | keep | The one runner for Josh 360's own jobs; new since the 8 November register. |
| `com.eventus.athena-test-suite-sync` | Hourly Athena test-suite sync | own plist (`agent_tools/athena_test_suite_sync.py`) | Athena test suite | loaded; last run exit 1; log 2026-11-16 | keep | Work pipeline for an accountability. Its last run failed: see "What the laptop run adds". |
| `com.eventus.clickup-notion-sync` | Hourly ClickUp to Notion sync | own plist (`agent_tools/clickup_notion_sync.py`) | ClickUp; Notion | plist present, not loaded, never logged | dismantle | Not loaded and no log file exists; archive the plist. |
| `com.atlassian.twg.upkeep` | Upkeep for Atlassian's `twg` tool, every 12 minutes | twg's own plist | `~/.config/twg/` | loaded, exit 0 | keep | Owned by another tool, like the `twg*` skill links. |
| `com.eventus.fcc-server` | Old local model proxy | was its own plist | Was `~/.config/free-claude-code/` | gone (confirmed 2026-11-16) | dismantle | Already retired; the laptop run confirms the plist and `~/.config/free-claude-code/` are gone. |

Processes that the apps start themselves (OpenCode server on 47601, action-triage trigger server on 47600, Atlas dashboard on 8770) are features, judged in JP-97.

## Hooks

From the live settings as audited on 8 November 2026 (29 hook commands on 13 events) and `settings.example.json`, checked against the laptop run of 16 November (`claude_settings`: 39 entries, the extra 10 being JP-105's `hooks/dispatch`).

| Item | What it is | Started by | Reads and writes | Last used | Verdict | Reason |
| --- | --- | --- | --- | --- | --- | --- |
| `atlas-hook.js` (claude-360) | Sends session events to Session Atlas | 8 events, every session | Hook input; posts to port 8770, spools on failure | live, 8 events | migrate | Becomes the ledger's recorder in josh-360's `hooks/` folder (JP-107, JP-111). |
| `atlas-removal-guard.js` (claude-360) | Blocks worktree removal until files are saved | PreToolUse Bash | Bash command; Atlas | not in the live settings | migrate | Fixes the "working files vanish" gap; moves with Atlas (JP-111). It is not wired on the laptop now, so the guard is off until then. |
| `jira-link-hook.sh` (claude-360) | Links sessions to Jira tickets in the cost ledger | PostToolUse Bash | Bash command; writes `jira_session_links` | live | migrate | Ticket links are ledger facts (JP-107). |
| `askHook.ts` (action-triage) | Sends Agent Manager questions to the Needs you tab | PreToolUse AskUserQuestion | Question store | live, from the `console-redesign-spec` worktree | migrate | Moves with action-triage (JP-124). The laptop run confirms its live path still points into a worktree folder, which breaks when that worktree is pruned; JP-105 should point it at the main checkout. |
| `desk_guard.py` (action-triage desk) | Limits tools in desk worker sessions | PreToolUse, every tool call | Session env | live | migrate | Moves with the desk (JP-124). |
| `agent-deck hook-handler` | Third-party session manager's hook, 7 events | live settings | Unknown (binary not inspected) | live, 7 events | dismantle | Josh dropped agent-deck in the feature-tree review (17 November, D1 and D2) and removes it himself on the laptop. |
| `claude-remote-*` (5 hooks) | "Tactic Remote" pings, including every tool call | Notification, PreToolUse, PostToolUse, SessionStart, Stop | Post to port 8765 | live, 5 events; port 8765 is held by a Python process | dismantle | The listener on 8765 is a Python process, most likely the focus dashboard (running, and set to that port), which has no handler for them, so they cost a call per tool use for nothing. Josh kept none of question 4's tools except agent-deck, pending detail (JP-106, Q12). |
| `secret-redact-post-tool-use.sh` | Redacts secrets in Bash output | PostToolUse Bash | Tool output | live | keep | Safety net. |
| `post-compact-load-handoff.py` | Re-injects STATE.md after compaction; prunes old session-state | SessionStart compact | `session-state/` | live | keep | STATE.md is the one per-session record (JP-100). |
| `precompact_state_refresh.py` | Rewrites STATE.md before compaction (one Haiku call) | PreCompact | Transcript tail; writes STATE.md | live | keep | One small call per compaction, not per turn; it keeps STATE.md accurate (JP-100). |
| `compaction/save_summary.py` | Saves each compaction summary (keeps 20) | PostCompact | Writes `session-state/<id>/compactions/` | live | dismantle | A second per-session record beside STATE.md (JP-100). |
| `compaction/meter.py` | Context-size warnings | not wired | Transcript | never live | dismantle | Never wired; only tests call it. |
| `focus-*` and `session-focus-inject.sh` (5) | The focus loop | example settings only | `session-focus/` | not live | dismantle | Off live; STATE.md and the ledger replace focus files (JP-100). |
| `session-to-wiki.sh` | Copies finished transcripts into the Obsidian wiki staging folder | not wired | Transcripts; writes full copies | not wired; its staging folder holds 1.1 GB, last change 2026-05-05 | dismantle | Not wired, and a copy of every transcript is what the ledger avoids. |
| `start-claude-mem-worker.sh` | Starts the claude-mem worker | not wired | — | not live | dismantle | claude-mem is off. |
| `precompact_write_handoff.py` | Old handoff writer | not wired (one function reused) | Writes `.planning/continue-here_*` | not live | dismantle | Replaced by STATE.md; keep the one function `precompact_state_refresh.py` imports. |
| `claude-keychain-auth-helper.sh` | Prints the Bifrost token from the keychain | `apiKeyHelper`, if set | Keychain | not set in the live settings | keep | Gateway sign-in for sessions when `apiKeyHelper` is set; the live settings do not set it now, so it is idle but harmless. |
| `pr-review-changes-requested-reminder.sh` | Reminds to plan before fixing a changes-requested PR | UserPromptSubmit | Marker files | live | keep | Pairs with the review ceremony. |
| `claude-stop-failure-toast.py` | Desktop notice when a turn dies on an API error | StopFailure | Transcript title | live | keep | Cheap and useful; the ledger can record the same fact later. |
| superpowers session-start hook | Loads the superpowers skill list | plugin | — | live | keep | Planning and building method. |
| Status line (`ccstatusline`) | Terminal status line | settings | — | live | keep | Display only. |

## Plugins and MCP servers

| Item | What it is | Started by | Reads and writes | Last used | Verdict | Reason |
| --- | --- | --- | --- | --- | --- | --- |
| claude-mem plugin | Cross-session memory with a worker and Chroma | plugin (off live, on in the example) | Transcripts; its own database | off; `~/.claude-mem` holds 4.5 GB, last change 2026-09-28 | dismantle | Off already; the ledger is the memory. Its 16 cached versions go on the deletion list. |
| context-mode plugin and marketplace copy | Context-saving plugin | not enabled | `~/.claude/context-mode/sessions/*.db` | 2026-03-23 | dismantle | Dormant for eight months. |
| superpowers | Skills library and hook | plugin | — | live | keep | Used in every build. |
| claude-md-management, feature-dev, playground, ponytail, atlassian | Other enabled plugins | plugins | — | live | keep | In use or cheap; JP-97 and later tickets can revisit. |
| Plugins only in `settings.example.json` (agent-sdk-dev, code-simplifier, codex, github, slack, builder-skills, skill-creator) | Example settings drift from live | example file only | — | not live | dismantle | Remove them from the example so it matches live; the github plugin also duplicates `gh`. |
| MCP server names in `~/.claude.json` | Servers such as claude-design and eventus-analytics | Claude Code | — | `claude-design`, `seq`, `tldraw-local`; 6 projects add their own | keep | Names only here; each is judged where it is used. |

## Memory and transcript readers

The ledger (JP-107) becomes the one memory of sessions, with pointers into transcripts rather than copies.

| Item | What it is | Started by | Reads and writes | Last used | Verdict | Reason |
| --- | --- | --- | --- | --- | --- | --- |
| Session Atlas | Session index, focus summaries, files, links, costs | `com.eventus.claude-atlas` and its hook | Transcripts in place; `atlas.db` (5.2 GB) | running; `atlas.db` 621 MB | migrate | Onto the ledger (JP-111); most features kept (JP-97). |
| Atlas per-turn focus worker | One Haiku call per finished turn in sessions with focus on | Atlas service | Transcript deltas; `focus_states` | `session-focus/` is empty, so it has nothing to summarise | dismantle | The vision retires per-turn model calls; summaries come once a session goes quiet (JP-108). |
| claude-mem | Plugin memory | plugin and worker | Transcripts | off | dismantle | See plugins. |
| Obsidian transcript staging | Full transcript copies for the wiki | `session-to-wiki.sh` (unwired) | Writes `~/Development/active/obsidian-wiki/raw/claude-sessions/` | 1.1 GB, 616 files, last change 2026-05-05 | dismantle | The ledger keeps pointers instead. |
| context-mode databases | 35 small session-event databases | old plugin | `~/.claude/context-mode/sessions/` | 2026-03-23 | dismantle | Dormant; archive. |
| STATE.md | Per-session fact record | the agent and the compaction hooks | `~/.claude/session-state/<id>/STATE.md` (309 folders) | live | keep | The one per-session record (JP-100). |
| Session focus files | Per-session focus anchor | the agent, focus hooks | `~/.claude/session-focus/` | empty (0 files) | dismantle | Overlaps STATE.md (JP-100). |
| Compaction summaries | Last 20 summaries per session | `save_summary.py` | `session-state/<id>/compactions/` | live | dismantle | Overlaps STATE.md (JP-100). |
| Handoff files | `continue-here` notes | `hand-off` skill, old hook | `.planning/` in projects and `~/.claude/.planning/archive/` | 2 files in `~/.claude/.planning/`, last change 2026-09-29 | dismantle | Replaced by STATE.md (JP-100). |
| Claude Code auto memory | Per-project `memory/MEMORY.md` | Claude Code | `~/.claude/projects/<slug>/memory/` | live | keep | Claude Code's own feature. |
| Agent memory folders | `agent-memory/` and `.agents/memory/` | Claude Code agent memory | small | 7 files, last change 2026-11-08 | keep | Used by agents that declare memory; the orphan is handled below. |
| `agent-memory/dashboard-architect/` | Memory for an agent with no definition | — | 2 files | inside `agent-memory/` (3 files, last change 2026-09-29) | dismantle | Orphan: no agent definition uses this memory. |
| Task-manager queue | One JSON file per to-do on OneDrive | `task-manager` skill | `.../claude_services/skills/task-manager/` | skipped (OneDrive); skill called 2 times, last 2026-10-01 | dismantle | Tickets are the work item, and this is one more task list. Question 4. |
| Obsidian wiki vault and its skills | Long-term knowledge base | wiki skills, on demand | `$OBSIDIAN_VAULT_PATH` | no wiki skill called in the window | dismantle | Josh: archive the wiki and its skills (JP-106, Q10). Archived, not deleted. |
| On-demand transcript readers (skills `find-conversation`, `recall`, `reflect`, `claude-history-ingest`, `show-me-your-work`, `cleanup-claude`, `automate-me`, `list-claude-processes`) | Read transcripts when asked | Josh or an agent | Transcripts | `find-conversation` 10 calls, `reflect` 4, `cleanup-claude` 2, `list-claude-processes` 1; the other four none | keep | They read only when called; once the ledger exists they can start from it. |
| Decision logs (`show-me-your-work`) | Audit trail of unattended work | the skill | `decisions.tsv` in a work folder | skill not called in the window | keep | Until decisions live in the ledger (JP-116). |
| `~/agentmemory/` and `~/.agentmemory` | Data of the agentmemory tool | an earlier memory tool | Its own store (571 MB, 12,035 files) | 2026-05-26 | dismantle | Dormant since May, and the ledger is the one memory; archive. Found by the laptop run. |

## Data stores

Sizes from the laptop run of 16 November 2026 (`stores`), or from the storage register of 8 November 2026 where the run does not measure them.

| Item | What it is | Started by | Reads and writes | Last used | Verdict | Reason |
| --- | --- | --- | --- | --- | --- | --- |
| `~/.claude/projects/` (9.3 GB, 7,512 files on 16 November) | Claude Code transcripts | Claude Code | Written by every session | live | keep | The source the ledger points into. Cleanup stays manual (`cleanup-claude`) until the ledger records pointers. |
| `~/.claude/atlas/atlas.db` (621 MB on 16 November, 5.2 GB on 8 November) | Atlas database | Atlas | Atlas | live | migrate | Onto the ledger (JP-111); its file-candidate rows still need a retention rule there. |
| `~/.claude/atlas/` backups and old copies (730 MB), spool (2,505 failed files) and rotated log (332 MB) | Atlas side files | Atlas | Atlas | spool 2026-11-09; backups 2026-11-08 | dismantle | Archive after JP-111; the spool files are events that never posted. |
| `~/.claude/cost-ledger/ledger.db` (635 MB) | Token and cost per message | Atlas import runner | Transcripts; ledger | live | migrate | Cost records move with Atlas onto the ledger (JP-111). |
| Cost-ledger `backups/` (1.7 GB) and the 17 October `.bak` and dry-run copies (1.1 GB) | Old copies | earlier migrations | — | backups 2026-11-13 | dismantle | Archive; deletion list. |
| `~/.claude/jobs/` (2.0 GB, 25,116 files, no retention) | Claude Code background-session folders | Claude Code | — | 2026-10-30 | keep | Claude Code's own; a retention rule is a later tidy. |
| `~/.claude/plugins/cache/` (16.2 GB) | Cached plugin versions | Claude Code | — | live | keep | Claude Code's own; old versions of switched-off plugins go on the deletion list. |
| `~/.claude/history.jsonl`, `file-history/`, `paste-cache/` | Prompt history and file snapshots | Claude Code | — | live | keep | Claude Code's own. |
| `~/.claude/session-state/` (17.5 MB) | STATE.md folders | hooks and agents | — | live | keep | See memory. |
| `~/.claude/sprint-state/` | Sprint lead and worker state | `sprint.py` | Agent Manager state, GitHub, Jira | 2026-11-16 (62 files) | build new | Graph run state replaces it (JP-114, JP-128). |
| `~/.claude/deliverables/` (27 MB, 1,596 files) | Files from `transcribe-social-post` | that skill | — | 2026-11-06 | keep | Small; Josh's rules retire `deliverables/` for new files, so the skill should move to the artifacts folder later. |
| `~/Library/Application Support/action-agent/` | Daemon state, questions, outbox, mailbox, review priority, archived session files | action-agent | — | live (114 MB) | migrate | Moves with action-triage onto the ledger (JP-124). |
| `~/Library/Application Support/action-triage/` | App state, prompt overrides | app | — | live (59 MB) | migrate | Moves with action-triage (JP-124). |
| `~/Library/Application Support/agent-services-desk/desk.db` | Desk ledger | desk scripts | — | 2026-11-16 | migrate | Moves with the desk and action-triage (JP-124). |
| Agent Command Center `server/data/meetings/` | `action-items.json`, Notion meeting data | meetings-sync, app | — | live (17 MB) | migrate | The last live part of Command Center; moves with JP-124. |
| `~/.claude/context-mode/` (4.3 MB) | Dormant databases | — | — | 2026-03-23 | dismantle | See memory. |
| `~/.claude-mem/` (4.5 GB) | claude-mem data and observer sessions | claude-mem | — | 2026-09-28 | dismantle | See memory. |
| Obsidian staging folder (1.1 GB, 616 files) | Transcript copies, if any | `session-to-wiki.sh` | — | 2026-05-05 | dismantle | See memory. |
| `~/.config/free-claude-code/` | fcc-server logs | — | — | gone (confirmed 2026-11-16) | dismantle | Confirmed gone. |
| `~/.local/share/opencode/`, `~/.pi/agent/sessions/` | Other clients' session stores | OpenCode, Pi | read by the cost ledger | OpenCode live (824 MB); Pi 2026-10-09 (27 MB) | keep | The cost records read them; they stay with those clients. |
| `~/.claude/daemon/`, `ccusage/`, `plans/`, `scheduled-tasks/`, `.playwright-cli/`, small caches | Claude Code and tool runtime files | various | — | live | keep | Small and owned by their tools. |
| `~/.omnara/` (483 MB) | Omnara's data and logs | Omnara | — | live | dismantle | Goes with Omnara (question 4). |
| `~/Library/Application Support/agent-manager/` (101 MB) | Agent Manager's state | Agent Manager | — | live | keep | Agent Manager is the session host (JP-117). |
| Leftover tool folders in `~` (`.claude-squad`, `.claude-code-ui`, `.codeagentswarm`, `.cagent`, `.claude-server-commander`, `.claude-monitor`, `.claude-worktrees`, `.agent-browser`, `.agents.pre-switch`, three `.atlas-test-*`, `opencode-plugin-backup-20261018`, `agent-manager-freeze-watch.txt`) | Data of tools tried and dropped, and test leftovers (65 MB in all) | — | Nothing reads them | between 2026-02-24 and 2026-10-11 | dismantle | Archive. Found by the laptop run. |
| 38 leftover copies of `~/.claude.json` (`.tmp.*`, `.bak-*`, `.backup`) | Copies left by interrupted writes, and old backups (11 MB) | Claude Code | Nothing reads them | between 2026-05-19 and 2026-09-09 | dismantle | Only `~/.claude.json` is read. Archive them on the laptop; they can hold MCP settings, so they are never shared. |
| Keychain items (Bifrost, Anthropic, GitHub App, Jira, Atlas, Athena) | Secrets | — | — | — | keep | Never read by this inventory. |

## Agent definitions

38 definitions in `~/.claude/agents/` (35 Markdown, 3 Codex TOML). "No caller" means no skill or rule names it (claude-harness `docs/harness/dependencies.md`). "Last used" is the number of agent calls in the transcripts from 18 August to 16 November 2026, about seven weeks of full records (see the appendix).

| Item | What it is | Started by | Reads and writes | Last used | Verdict | Reason |
| --- | --- | --- | --- | --- | --- | --- |
| `docs-sync-reviewer` | Fixes stale documentation | global rules | Docs | 73 calls, last 2026-11-06 | keep | Required by Josh's global rules. |
| `web-researcher` | All web search and fetch | global rules | Web | 78 calls, last 2026-11-09 | keep | Required by Josh's global rules; drop the stale claude-mem tools from its list. |
| `security-auditor` | Security audit | `pr-security-review`, `tasks-issue` | Code | 17 calls, last 2026-11-11 | keep | Used by the PR security review. |
| `data-analyst` | Answers data questions | `equip-questions` and others | Databases | 16 calls, last 2026-11-12 | keep | Has callers. |
| `comment-sicko` | Comment reviewer | `no-comments` | Code | none in the window | keep | Has a caller. |
| `code-debugger` | Diagnoses errors | on request | Code | 21 calls, last 2026-11-11 | keep | General use. |
| `log-searcher` | Searches logs | on request | Logs | 14 calls, last 2026-10-31 | keep | General use. |
| `issue-tracker` | Documents bugs found outside development, on request | on request | Notes | none in the window | keep | Josh's rules allow it when asked. |
| `project-folder-organizer` | Tidies a project folder | on request | Files | 1 call, last 2026-10-01 | keep | General use. |
| `tailwindadmin-ui-engineer` | Builds TailwindAdmin UI | on request | Code | none in the window | keep | Paired with the `tailwindadmin-ui` skill. |
| `foreman-analyst`, `foreman-scout`, `foreman-verifier`, `foreman-worker` | Roles for fable-foreman | fable-foreman | Code | analyst 19, scout 1, verifier 58, worker 40; last 2026-11-06 | keep | A working orchestration pattern the graphs can learn from (JP-101). |
| `luna-sdd-worker`, `luna-sdd-reviewer` | Subagent-driven development roles | SDD runs | Code | worker 140, reviewer 208; last 2026-11-16 | keep | Used by SDD runs. |
| `poteto-agent` | Routing target for poteto-mode | `poteto-mode` | Code | none in the window | keep | Has a caller. |
| `keystone-branch-reviewer` | Keystone branch review | on request | Code | none in the window | keep | Project-specific but live work. |
| `signature-standards-design-reviewer` | Keystone signature-standards review | on request | Code | none in the window | keep | Project-specific but live work. |
| `hl7-evidence-auditor` | HL7 receipt evidence audit | on request | Data | none in the window; edited 2026-11-06 | keep | Work audits recur. |
| `email-manager` | Sends and drafts Outlook email | `tasks-email`, `tasks-todo` | Outlook | 5 calls, last 2026-11-14 | keep | General mail helper; its Command Center callers go, it does not. |
| `code-simplifier` | Simplifies changed code | on request | Code | 2 calls, last 2026-11-06 | keep | The duplicate is the example-only plugin, removed above. |
| `claude-optimizer` | Audits Claude config | no caller | Config | 2 calls, last 2026-10-06 | keep | No caller, but Josh called it directly in the window. |
| `code-quality-strike-team` | Whole-codebase audit | no caller | Code | none in the window | dismantle | No caller and no call in the window; archive (reversible). Changed from keep by the laptop run. |
| `official-docs-finder` | Finds official docs | no caller | Web | 2 calls, last 2026-10-05 | keep | No caller, but called directly in the window. |
| `pr-high-effort-reviewer` | Deep review of one PR | no caller | Code | 12 calls, last 2026-11-12 | keep | No caller, but called directly in the window. |
| `prompt-optimizer` | Clarifies vague requests | no caller | — | none in the window | dismantle | No caller and no call in the window; archive (reversible). Changed from keep by the laptop run. |
| `smart-brevity-author`, `smart-brevity-educator` | Writing styles | no caller | — | none in the window | dismantle | No caller and no call in the window; archive (reversible). Changed from keep by the laptop run. |
| `tdd-testing-orchestrator` | Test-driven development runs | no caller | Code | 2 calls, last 2026-10-01 | keep | No caller, but called directly in the window. |
| `ui-ux-critic` | UI review | no caller | — | none in the window | dismantle | No caller and no call in the window; archive (reversible). Changed from keep by the laptop run. |
| `notion-explorer` | Reads Notion | on request | Notion | 21 calls, last 2026-11-06 | keep | Called often; its client path was reported missing on 8 November, so check that path rather than drop it. |
| `slack-task-updater` | Slack updates for Command Center tasks | no caller | Slack | none in the window | dismantle | Command Center is retired. |
| `task9-code-reviewer` | Review of Athena Task 9 tests | no caller | Code | none in the window | dismantle | A one-off for finished work. |
| `word-notion-comparator` | Compares a Word file with Notion | no caller | Files | none in the window | dismantle | A one-off. |
| `docs-researcher.toml`, `explorer.toml`, `reviewer.toml` | Codex profiles | Codex | — | not counted (Codex, not Claude Code) | keep | Codex reads them; cheap to keep. |

## Skills

219 skill folders in `~/.claude/skills/` on 16 November (217 on 8 November), plus 14 `twg` links, 8 test-workspace folders and 4 packaged files; `.agents/skills/` holds the six Paseo skills, `tailwindadmin-ui` and the same 14 links. Rows below are the skills with a reason to change, then one row for the rest. "Last used" counts Skill calls and slash commands over the same window as the agents.

| Item | What it is | Started by | Reads and writes | Last used | Verdict | Reason |
| --- | --- | --- | --- | --- | --- | --- |
| `tasks-email`, `tasks-issue`, `tasks-todo` | Work items from the Command Center queue | on request | Command Center | none in the window | dismantle | Command Center is retired; the desk and tickets replace it. |
| `action-triage-issue`, `report-harness-block` | File action-triage GitHub issues | on request | GitHub | first none; second 1 call, 2026-10-06 | dismantle | action-triage's GitHub-issue path is legacy; Jira tickets are the work item. Switch off with action-triage's phase 8. |
| `session-transplant` | Moves a conversation into a fresh background session to escape fcc-claude | on request | Transcripts | none in the window | dismantle | fcc-claude and litellm are retired. |
| `focus` | Focus loop | on request, and Atlas turns focus on from it | `session-focus/` | none in the window | dismantle | Josh never calls it by hand; STATE.md and the ledger replace it (JP-100). |
| `task-manager` | OneDrive to-do queue | on request | OneDrive | 2 calls, last 2026-10-01 | dismantle | Question 4. |
| `sprint` (and its waker and watchdog scripts) | Runs Jira tickets through lead and worker sessions | `/sprint` | Agent Manager, Jira, GitHub | 3 calls, last 2026-11-05 | build new | Runs until the development graph replaces it (JP-115, JP-128). |
| `flow_resubmit` | Duplicate of `flow-resubmit` | on request | — | none in the window (nor `flow-resubmit`) | dismantle | Two folders for one skill; keep `flow-resubmit`. |
| `cloud-pr-handoff` (laptop only, no SKILL.md) | Stray folder beside `pr-cloud-handoff` | — | — | 2 calls by this name, last 2026-11-06 | dismantle | It has no SKILL.md, so it never loads; the calls by this name cannot have reached it. Keep `pr-cloud-handoff`. |
| Test-workspace folders (8, `*-workspace`) | Skill eval scratch folders | skill-creator | — | none called | dismantle | Eval output, not skills; archive. |
| Packaged files (4, `.zip` and `.skill`) | Built skill packages | skill-creator | — | not listed (the run lists folders) | dismantle | Build output; archive. |
| Obsidian wiki family (12) | Wiki ingest, query and gardening | on request | Wiki vault | none called in the window | dismantle | Archived with the wiki (JP-106, Q10). |
| Paseo skills (6), in `skills/` and `.agents/skills/` | Paseo orchestration | on request | Paseo | none called in the window | keep | Paseo is a possible future host for the graphs; the two copies are byte-identical, so one copy can be retired once Josh's skill-store rule says which. |
| `twg*` links (14) | Links to `~/.config/twg/skills` | — | — | none called in the window | keep | Owned by another tool. |
| All other skills (190 of the 219 real skill folders) | Method, Git and PR, data and Azure, Athena, email, writing, design, harness skills | on request | various | 88 of the 219 called (1,467 calls) | keep | In use or cheap to keep. The 131 skills with no call in the window are listed in the appendix; question 8 proposes which to archive. |

## Tools and scripts

| Item | What it is | Started by | Reads and writes | Last used | Verdict | Reason |
| --- | --- | --- | --- | --- | --- | --- |
| `tools/session-dashboard-server.py` | The focus dashboard | `com.eventus.focus-dashboard` | `session-focus/`, transcripts | running (port 8765) | dismantle | Goes with the focus dashboard job. |
| `tools/focus_parse.py`, `tools/test_focus_files.py` | Focus helpers and tests | imported | — | — | dismantle | Go with the focus loop. |
| `tools/promote_*`, `tools/instruction-consolidation/` | One-time migration tools | by hand | Skill and instruction trees | not measured (scripts run by hand leave no record) | keep | Small; archive once their migrations are confirmed done. |
| `scripts/sync-live.sh` | Syncs the harness repository into `~/.claude` | by hand | Repo and live folder | not measured (scripts run by hand leave no record) | keep | How harness changes reach the laptop. |
| `scripts/cleanup-claude-projects.sh` | Deletes old transcripts (dry run by default) | by hand | `~/.claude/projects/` | not measured; the `cleanup-claude` skill was called 2 times, last 2026-11-07 | keep | Manual cleanup; the ledger's pointers will say what is safe to delete. |
| `docs/harness/generate_inventory.py` | Regenerates the harness register | by hand | `~/.claude` | 2026-11-08 | keep | Complements this script, which covers jobs and figures. |
| `bin/sync-opencode-agents.py` | OpenCode agent sync | its job | Agents | its job is loaded, exit 0 | keep | Kept with its job and fixed (JP-106, Q11). |
| `commands/seq_tool.md`, `commands/apps.md`, `commands/save-session.md` | Slash commands | by hand | — | `apps` 8 calls, `seq_tool` 4, `save-session` none | keep | `save-session` uses the old handoff path; it changes with JP-100. |
| `scripts/laptop_inventory.py` (josh-360) | This inventory's laptop step | the JP-105 job `inventory`, once; or by hand | Reads only; writes its report to standard output or one new file | ran 2026-11-16 (88.7 s) | keep | The repeatable way to refresh this file. |

## Dismantling plan

Each item is switched off and archived, which is reversible and needs nobody. Permanent deletion waits for the phase 1 close (JP-120), where Josh approves one list. The archive folder is `~/Archive/josh-360-retired/<date>/<item>/` on the laptop, with a one-line `README` saying where the item came from and how to put it back.

| Item | Switch off | Archive | Deletion list (JP-120) |
| --- | --- | --- | --- |
| `com.eventus.acc-launch-spawner` | Already gone (16 November run) | — | The Command Center server code once JP-124 has moved its data |
| `com.eventus.focus-dashboard` and its tools | bootout | Plist; `tools/session-dashboard-server.py`, `focus_parse.py`, `test_focus_files.py` | Those files |
| `com.jgilpatrick.claude-mem-worker`, claude-mem plugin and hook | Worker already gone; plugin already off | `start-claude-mem-worker.sh`, `~/.claude-mem/` (4.5 GB) | `~/.claude-mem/`, 16 cached plugin versions |
| `com.eventus.qa-waker-watchdog` | bootout | Plist | Plist |
| `com.josh.quicktasks` | Already gone (16 November run) | Its data folder, if any remains | Data folder |
| `com.omnara.daemon` | bootout (after question 4) | Plist and `~/.omnara/` (483 MB) | `~/.omnara/` |
| `com.eventus.fcc-server` | Already off | — | Nothing: the plist and `~/.config/free-claude-code/` are confirmed gone |
| `com.eventus.meeting-watcher` | Already gone (16 November run) | — | — |
| `com.eventus.clickup-notion-sync` | Already not loaded | Its plist | Plist |
| Tactic Remote hooks (5); agent-deck hooks (7), which Josh removes himself (feature-tree review, 17 November) | Remove their entries from `~/.claude/settings.json` (back the file up first) | The hook scripts | The hook scripts |
| Focus hooks (done in JP-100: archived in claude-harness `archive/focus/`, PR waits for the phase 1 close), `meter.py`, `session-to-wiki.sh`, `precompact_write_handoff.py` (keep the one imported function), `save_summary.py` | Remove from settings where wired | The scripts; `session-focus/` (empty), the Obsidian staging folder (1.1 GB of full transcript copies, so it stays on the laptop like the transcripts), compaction summaries | Same |
| context-mode | Already off | `~/.claude/context-mode/`, `plugins/marketplaces/context-mode/` | Both |
| Atlas per-turn focus worker | Turned off in JP-111 (no focus activation) | — | — |
| Atlas backups and old copies (730 MB), failed spool files, cost-ledger `backups/`, `.bak` and dry-run copies (2.8 GB) | After JP-111 proves the ledger | Move to the archive | All of them |
| Example-only plugins | Remove from `settings.example.json` | — | — |
| Agents `slack-task-updater`, `task9-code-reviewer`, `word-notion-comparator`, `code-quality-strike-team`, `prompt-optimizer`, `smart-brevity-author`, `smart-brevity-educator`, `ui-ux-critic`; orphan `agent-memory/dashboard-architect/` | Move out of `~/.claude/agents/` | Archive | Same |
| `~/agentmemory/`, `~/.agentmemory` | Nothing runs them | Archive (571 MB) | Both |
| Leftover tool folders in `~` and the 38 copies of `~/.claude.json` (see Data stores) | Nothing reads them | Archive | All of them |
| Skills `tasks-*`, `session-transplant`, `focus`, `flow_resubmit`, `cloud-pr-handoff`, test workspaces, packaged files | Move out of `~/.claude/skills/` | Archive | Same |
| Skills `action-triage-issue`, `report-harness-block` | With action-triage's phase 8 | Archive | Same |
| `task-manager` skill and its OneDrive queue (after question 4) | Stop using; move the skill | Archive the queue folder | Queue folder |

The harness changes go through claude-harness pull requests at the phase close, under Josh's rule that pull requests to his other repositories wait for it.

## Questions for the phase 1 sitting

Collected for JP-106, each with a recommendation. The verdicts above already take the recommended option, so nothing waits on these.

1. **Session Atlas's per-turn summaries.** Retire the Haiku call that runs after every turn in focus sessions? *Recommendation: yes, as the vision says; the ledger writes five lines when a session goes quiet (JP-108).*
2. **The Obsidian wiki.** Keep the wiki and its skills, with the transcript staging hook retired? *Recommendation: yes. The wiki holds knowledge, not session memory; if Josh no longer uses it, the twelve wiki skills move to the dismantle list.* The laptop run found no call of any wiki skill in the window and nothing added to the staging folder since 5 May, which suggests the wiki is not in daily use.
3. **OpenCode.** Is OpenCode still a client Josh uses directly? *Recommendation: retire the hourly agent sync (its models are retired) and keep OpenCode only as action-triage's chat engine.*
4. **Leftover tools.** Retire QuickTasks, Omnara, the agent-deck hooks, the Tactic Remote hooks and the task-manager queue? The laptop run shows QuickTasks is already gone, Omnara is running (its log changed on 16 November), and the `task-manager` skill was called twice, last on 1 October. *Recommendation: yes for all five; each is a second copy of something Agent Manager, Claude Code or Jira already does. If any is still in daily use, say which and it stays.*
5. **The focus loop.** Retire the `focus` skill and focus files in favour of STATE.md? *Recommendation: yes, with JP-100.*
6. **Duplicated skill copies.** For the six Paseo skills present in both `skills/` and `.agents/skills/`, which copy is the real one? *Recommendation: `.agents/skills/`, as Josh's global rules describe; retire the other.*
7. **The rclone backup.** `com.jgilpatrick.rclone-sync` is not installed, so `~/josh_personal` is not being copied to Google Drive by it. Is that backup still wanted? *Recommendation: if yes, add it back as a JP-105 job so Josh 360 keeps it running; if not, mark it dismantle.*
8. **Skills with no call in the window.** 131 skills had no call in about seven weeks of records (appendix). Archive them? *Recommendation: keep any that a rule or another skill names (for example `bulk-email-safety` from the global rules and the `principle-*` set that `poteto-mode` reads), and archive the rest at the phase close. Archiving is reversible: a skill that is missed comes back from the archive in one move.*

**Answered at the JP-106 sitting (16 November 2026)**, recorded in `docs/decisions.md`: Q1 and Q5 were already decided (the vision); Q2 archive the wiki and its skills; Q3 keep OpenCode and fix its agent sync to run on change; Q4 retire Omnara, the Tactic Remote hooks and the task-manager queue, QuickTasks is already gone, agent-deck waits for the feature-tree review; Q6 settled by Josh's skill-store rule; Q7 no rclone backup; Q8 Josh picks the skills to keep himself.

## What the laptop run adds

The run was the JP-105 job `inventory`, which ran `scripts/laptop_inventory_job.py` once on 16 November 2026 (88.7 seconds) and put its report on `laptop-status` as `reports/inventory.json` (173 KB, nothing trimmed). The report holds names, paths, sizes, dates and counts only. As a background job it left out the folders macOS may guard with a privacy prompt (iCloud, OneDrive, Desktop, Documents, Downloads), including anything that reaches them through a symlink, so the one OneDrive store above reads "skipped". It did not run `brew`, which writes its own cache even to list services; Homebrew's PostgreSQL still shows as a launchd plist.

What it changed in this file:

- **Jobs.** Five dismantle items are already gone (Command Center server, claude-mem worker, QuickTasks, meeting watcher, fcc-server), so the meeting watcher moved from migrate to dismantle. Four jobs were missing from the repositories and are added: Josh 360's own runner, an hourly Athena test-suite sync, an installed but unloaded ClickUp to Notion sync, and the `twg` tool's upkeep. The rclone backup is not installed (question 7).
- **Jobs that failed at their last run.** `com.eventus.athena-pipeline` (exit 2), `com.eventus.azure-batch-spend-alert` (exit 1) and `com.eventus.athena-test-suite-sync` (exit 1) are work jobs whose last run ended with an error, and their logs changed on 16 November. The inventory never reads file contents, so the cause is not known here. Next step: read `/tmp/athena-pipeline.log`, `/tmp/azure-batch-spend-alert.err` and `/tmp/athena-test-suite-sync.log` on the laptop. These jobs are outside Josh 360, so this is for Josh rather than a JP ticket. The QA waker watchdog also exits 1, but it is being dismantled.
- **Hooks.** 39 hook entries on 13 events: the 29 of 8 November plus JP-105's `hooks/dispatch` on its 10 events. `atlas-removal-guard.js` is not wired, so the "files vanish" guard is off until JP-111. `askHook.ts` still runs from an action-triage worktree. No `apiKeyHelper` is set.
- **Sizes.** `atlas.db` is down from 5.2 GB to 621 MB; old copies beside the Atlas and cost-ledger databases add up to about 3.5 GB. Newly found: `~/.claude-mem` (4.5 GB), `~/agentmemory` (571 MB, idle since May), `~/.omnara` (483 MB), about 65 MB of folders left by tools tried and dropped, and 38 stray copies of `~/.claude.json`.
- **Agents.** Five agents with no caller and no call in the window move to dismantle (appendix).

## Appendix: skills and agents with no recent use

From the laptop run of 16 November 2026: every skill folder and agent definition with no Skill call, slash command or agent call in the transcripts from 18 August 2026 (`definitions` against `figures.skill_use` and `figures.agent_use`). Few transcripts from before 28 September survive (2 or 3 sessions a week, against 31 to 307 afterwards), so the real window is about seven weeks. A skill that another skill or a rule reads by path, rather than calling it, shows here too.

**Skills: 131 of the 219 skill folders.** The 8 test-workspace folders and 12 of the 14 `twg*` links were not called either. Question 8 decided what to archive; Josh's picks are below.

**Josh's picks (JP-106, Q14, sent 16 November 2026).** Of the 131, 67 are kept and 64 are archived at the phase close (reversible).

- Kept, the pstack set (44): every `principle-*` skill and the rest of pstack.
- Kept, others (23): `archify`, `azure-quota-request`, `bulk-email-safety`, `control-cli`, `define-done`, `deslop`, `flow-resubmit`, `git-corruption-repair`, `github-issue`, `grill-with-docs`, `image-to-code-skill`, `improve-codebase-architecture`, `maintain-verification-skill`, `redesign-skill`, `review-and-ship`, `run-smoke-tests`, `scheduler-health`, `sqlite-postgres-portability`, `stitch-skill`, `supervising-attestation`, `thermo-nuclear-code-quality-review`, `ui-bug-exploration`, `verify-this`. Three of these (`control-cli`, `deslop`, `grill-with-docs`) were added after his picks because a kept skill names them: `poteto-mode` and `verify-this` name `control-cli`, `poteto-mode` names `deslop`, and `improve-codebase-architecture` links to files inside `grill-with-docs`.
- Archived (64): `action-triage-issue`, `ambience-sftp`, `athena-briefing`, `athena-ui-chart-review`, `azure-quotas`, `brutalist-skill`, `caveman`, `check-compiler-errors`, `claude-history-ingest`, `cross-linker`, `data-ingest`, `dataview`, `equip-questions`, `excalidraw-figjam-style`, `file-relay`, `find-my-skills`, `fix-ci`, `flow_resubmit`, `focus`, `get-lacy-messages`, `get-pr-comments`, `grill-me`, `hand-off`, `intel`, `llm-wiki`, `loop-on-ci`, `make-pr-easy-to-review`, `markdown-grid`, `minimalist-skill`, `output-skill`, `paseo`, `paseo-advisor`, `paseo-committee`, `paseo-handoff`, `paseo-help`, `prompt-me`, `prompt-me-build`, `session-transplant`, `setup-matt-pocock-skills`, `soft-skill`, `sql-relay`, `synapse-equip-routine`, `tag-taxonomy`, `tasks-email`, `tasks-issue`, `tasks-todo`, `taste-skill`, `to-issues`, `to-prd`, `transcribe-social-post`, `triage`, `weekly-review`, `what-did-i-get-done`, `wiki-ingest`, `wiki-lint`, `wiki-query`, `wiki-rebuild`, `wiki-setup`, `wiki-status`, `wiki-update`, `word-doc`, `workflow-from-chats`, `write-a-skill`, `zoom-out`.

- `principle-*` (24), read by `poteto-mode` (itself not called): `principle-attack-the-premise`, `principle-boundary-discipline`, `principle-build-the-lever`, `principle-encode-lessons-in-structure`, `principle-exhaust-the-design-space`, `principle-experience-first`, `principle-explain-the-number`, `principle-fix-root-causes`, `principle-foundational-thinking`, `principle-guard-the-context-window`, `principle-laziness-protocol`, `principle-make-operations-idempotent`, `principle-migrate-callers-then-delete-legacy-apis`, `principle-minimize-reader-load`, `principle-model-the-domain`, `principle-never-block-on-the-human`, `principle-outcome-oriented-execution`, `principle-prove-it-works`, `principle-redesign-from-first-principles`, `principle-separate-before-serializing-shared-state`, `principle-sequence-verifiable-units`, `principle-subtract-before-you-add`, `principle-test-behavior-not-implementation`, `principle-type-system-discipline`.
- Obsidian wiki family and helpers (13): `claude-history-ingest`, `cross-linker`, `data-ingest`, `dataview`, `llm-wiki`, `tag-taxonomy`, `wiki-ingest`, `wiki-lint`, `wiki-query`, `wiki-rebuild`, `wiki-setup`, `wiki-status`, `wiki-update`.
- Paseo (5): `paseo`, `paseo-advisor`, `paseo-committee`, `paseo-handoff`, `paseo-help`.
- Everything else (89): `action-triage-issue`, `ambience-sftp`, `archify`, `architect`, `arena`, `athena-briefing`, `athena-ui-chart-review`, `automate-me`, `azure-quota-request`, `azure-quotas`, `benchmark-checklist`, `blast-radius`, `brutalist-skill`, `bulk-email-safety`, `caveman`, `check-compiler-errors`, `control-cli`, `correct`, `define-done`, `deslop`, `equip-questions`, `excalidraw-figjam-style`, `figure-it-out`, `file-relay`, `find-my-skills`, `fix-ci`, `flow-resubmit`, `flow_resubmit`, `focus`, `get-lacy-messages`, `get-pr-comments`, `git-corruption-repair`, `github-issue`, `grill-me`, `grill-with-docs`, `hand-off`, `how`, `image-to-code-skill`, `improve-codebase-architecture`, `intel`, `interrogate`, `loop-on-ci`, `maintain-verification-skill`, `make-pr-easy-to-review`, `markdown-grid`, `minimalist-skill`, `no-comments`, `output-skill`, `poteto-mode`, `prompt-me`, `prompt-me-build`, `recall`, `redesign-skill`, `review-and-ship`, `run-smoke-tests`, `scheduler-health`, `session-transplant`, `setup-matt-pocock-skills`, `show-me-your-work`, `soft-skill`, `sql-relay`, `sqlite-postgres-portability`, `stitch-skill`, `supervising-attestation`, `swarm`, `synapse-equip-routine`, `tasks-email`, `tasks-issue`, `tasks-todo`, `taste-skill`, `tdd-pstack`, `teach`, `technical-writing`, `thermo-nuclear-code-quality-review`, `to-issues`, `to-prd`, `transcribe-social-post`, `triage`, `typescript-best-practices`, `ui-bug-exploration`, `unslop`, `verify-this`, `weekly-review`, `what-did-i-get-done`, `why`, `word-doc`, `workflow-from-chats`, `write-a-skill`, `zoom-out`.

**Agents: 18 of the 38 definitions**: 15 Claude Code agents, plus the 3 Codex profiles (`docs-researcher`, `explorer`, `reviewer`), which Claude Code never calls.

- No caller and no call, now dismantle: `code-quality-strike-team`, `prompt-optimizer`, `smart-brevity-author`, `smart-brevity-educator`, `ui-ux-critic`.
- Already dismantle (one-offs or retired tools): `slack-task-updater`, `task9-code-reviewer`, `word-notion-comparator`.
- Kept, because a skill or rule calls them or they serve current project work: `comment-sicko`, `hl7-evidence-auditor`, `issue-tracker`, `keystone-branch-reviewer`, `poteto-agent`, `signature-standards-design-reviewer`, `tailwindadmin-ui-engineer`.

Agents with no caller that were called directly, and so stay: `claude-optimizer` (2 calls), `official-docs-finder` (2), `pr-high-effort-reviewer` (12), `tdd-testing-orchestrator` (2).
