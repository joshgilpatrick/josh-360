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

What only the laptop can say (which jobs are loaded, current sizes, when each thing last ran, which skills and agents were used) comes from the one read-only script, `scripts/laptop_inventory.py`. The laptop runs it once on its own, as the JP-105 job `inventory`, and its report comes back on the `laptop-status` branch as `reports/inventory.json`. Where a row says "laptop run", that is the field that answers it. A verdict that the run contradicts is changed in the pull request that brings the run back.

The features of action-triage and Session Atlas have their own ticket (JP-97). Here they appear only as jobs, hooks and stores. Nothing is switched off by this ticket.

## Answers to the ticket's questions

**Which background jobs are still needed, and which belong to retired tools?** The vision counted about twenty. The repositories name 28 launchd jobs or job templates. Thirteen stay as they are (personal chores, work pipelines, the login startup list, Agent Manager). Six move into josh-360 with action-triage and Session Atlas, including the two meeting jobs that still run from Agent Command Center. Eight belong to retired tools or to tools the ledger replaces and are dismantled: the Agent Command Center server, the old focus dashboard, the claude-mem worker, the QA waker watchdog, the OpenCode agent sync, Omnara, QuickTasks, and the already-removed fcc-server (confirm it is gone). One more, the sprint watchdog, is built new as part of the development graph. See [Background jobs](#background-jobs).

**Are claude-mem and the Obsidian transcript staging kept, replaced by the ledger, or dismantled?** Both are dismantled. claude-mem is already switched off in the live settings (16 cached versions remain), and the Obsidian staging hook is not wired in either settings file. The ledger keeps a pointer to each transcript instead of a copy, so neither is needed. The Obsidian wiki itself and its skills are kept. Session Atlas moves onto the ledger (JP-111), its per-turn summary worker is retired, and the dormant context-mode databases are archived. That leaves one reader of transcripts, the ledger. See [Memory and transcript readers](#memory-and-transcript-readers).

**Which skills and agent definitions show no recent use?** Use counts need the laptop: the script counts every Skill call, slash command and agent call over the last 90 days. The count and list go in the [appendix](#appendix-skills-and-agents-with-no-recent-use) when the run returns. From the repositories alone, 13 agent definitions have no caller in any skill or rule, and 20 skill folders and files are tied to retired tools, duplicated, or left over from skill builds.

**What are the starting figures?** In `docs/inventory/starting-figures.md`. The two cloud figures are in (18 open pull requests by Josh, 19 JP and AD tickets in flight on 16 November 2026). The laptop figures arrive with the run.

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
| `com.jgilpatrick.startup` | The one login job; loads every plist in `launchd/startup-manifest.txt` | launchd at login | Reads the manifest; loads jobs | laptop run: `launchctl.jobs` | keep | The vision reuses this list for every Josh 360 job (JP-105, JP-119). |
| `com.jgilpatrick.automations-hub` | Receipt watcher: names and files receipts with a Claude call | startup list, always on | `receipts/receipt_inbox/`; writes `receipts/` | laptop run: log `/tmp/automations-hub.log` | keep | A personal chore outside the agent workflow. |
| `com.jgilpatrick.outlook-receipt-fetcher` | Weekly Outlook receipt sweep | startup list, Fridays 5 PM | Outlook `Receipt` folder; writes `receipt_inbox/` | laptop run | keep | Personal chore. |
| `com.jgilpatrick.claude-transcript-scrubber` | Gitleaks scan that redacts secrets in transcripts | startup list, daily | Reads and rewrites `~/.claude/projects/**/*.jsonl` in place | laptop run | keep | It removes secrets rather than keeping a memory, so it is not a fourth reader; the ledger keeps pointers, so redaction stays useful. |
| `com.jgilpatrick.idemeum-log-retention` | Deletes Idemeum logs over 24 hours old | startup list, daily 03:17 | Idemeum log folder | laptop run | keep | Machine hygiene. |
| `com.jgilpatrick.agent-manager` | Starts Agent Manager in tmux at login | startup list, at login | Agent Manager's own state | laptop run | keep | The graphs bind to Agent Manager first (JP-117). |
| `com.jgilpatrick.sync-opencode-agents` | Copies `~/.claude/agents` into OpenCode agents | startup list, hourly | `~/.claude/agents`; writes `~/.config/opencode/agents` | laptop run | dismantle | Its model map still targets `litellm/...`, which was retired, so the agents it writes cannot run. Question 3. |
| `com.jgilpatrick.sync-client-skills` | Keeps skill links for OpenCode, Pi and Codex | its own plist, when `~/.claude/skills` changes | `~/.claude/skills`; writes links in `~/.opencode`, `~/.pi`, `~/.codex` | laptop run | keep | Josh's global rules keep one skill store linked into each client. |
| `com.eventus.action-agent` | action-triage orchestrator: picks up work, runs sessions and PR audits | own plist, always on | GitHub, Jira, transcripts in place; writes `~/Library/Application Support/action-agent/` | laptop run | migrate | Moves into josh-360 with action-triage (JP-124). |
| `com.eventus.action-triage` | action-triage desktop app | own plist, at login | Many stores read-only; writes its app folder and logs | laptop run | migrate | Moves with action-triage (JP-124). Which of its two plist forms is installed is a laptop-run fact. |
| `com.eventus.desk-watcher` | Email Research Desk: hands new emails to the desk coordinator each minute | own plist, every 60 s (loaded at cutover) | Email log endpoint; writes `desk.db` | laptop run | migrate | Part of action-triage's intake; moves with it (JP-124). |
| `com.eventus.claude-atlas` | Session Atlas service: dashboard on port 8770 and nine runners | own plist, always on | Transcripts in place, hook events; writes `~/.claude/atlas/`, `~/.claude/cost-ledger/` | laptop run | migrate | Moves into josh-360 and onto the ledger (JP-111). |
| `com.eventus.meetings-sync` | Pulls meetings from Notion every 15 minutes and extracts action items | Agent Command Center's plist | Notion; writes `action-items.json` and meeting files | laptop run | migrate | Runs Agent Command Center's copy of the script while action-triage holds the maintained copy; repoint it when action-triage moves (JP-124). |
| `com.eventus.meeting-watcher` | Triggers the Notion sync when a meeting ends | Agent Command Center's plist | Meeting state | laptop run | migrate | Same pipeline as meetings-sync; action-triage's trigger server already takes the meeting-ended nudge (JP-124). |
| `com.eventus.acc-launch-spawner` | Agent Command Center Node server | Agent Command Center's plist | Its own data | laptop run | dismantle | Command Center is retired; only its data folder is still used, and that moves with JP-124. |
| `com.eventus.athena-pipeline` | Nightly 2 AM Athena PM pipeline | athena_transition project | Athena data | laptop run | keep | Work pipeline for an accountability, not agent plumbing. |
| `com.eventus.azure-batch-spend-alert` | Daily 8 AM Azure spend alert | own plist (script not in any repo here) | Azure cost APIs; sends email | laptop run | keep | A work alert. Its script is not in a repository, which the laptop run's path confirms. |
| `com.eventus.focus-dashboard` | Focus dashboard on port 8765 | own plist | `~/.claude/session-focus/`, transcripts | laptop run | dismantle | The focus hooks are not wired live, and STATE.md plus the ledger replace focus files (JP-100). |
| `com.jgilpatrick.claude-mem-worker` | claude-mem indexing worker | own plist | Transcripts and tool events; claude-mem's store | laptop run | dismantle | The plugin is off in live settings; the ledger replaces it. |
| `com.eventus.qa-waker-watchdog` | Watchdog copied from a QA sprint waker | own plist | Waker heartbeat | laptop run | dismantle | Left over from one QA sprint. |
| `com.jgilpatrick.sprint-waker-<slug>` | Per-sprint watchdog for the sprint waker | `sprint.py install-watchdog` | Heartbeat file; desktop notice | laptop run | build new | The sprint skill runs until the development graph and walker replace it (JP-115, JP-128). |
| `com.jgilpatrick.notion-skill-sync` | Planned job that publishes skills to Notion | own plist, if built | Skills; Notion | laptop run | keep | Planned on 6 November 2026 and outside Josh 360; its code is not in a repository here. |
| `com.jgilpatrick.rclone-sync` | Syncs `~/josh_personal` to Google Drive every 30 minutes | own plist | Personal folder | laptop run | keep | Personal backup. |
| `com.josh.outlook-watchdog` | Keeps Outlook running | own plist | Outlook process | laptop run | keep | The desk mailer and receipt fetcher need Outlook. |
| `com.josh.quicktasks` | QuickTasks web app | own plist | Its own task store | laptop run | dismantle | One more task list beside tickets, Linear and the task-manager queue. Question 4. |
| `com.omnara.daemon` | Omnara third-party remote-control daemon | own plist | Omnara's own data | laptop run | dismantle | Claude Code's own remote control and Agent Manager cover it. Question 4. |
| `homebrew.mxcl.postgresql@14` | Local PostgreSQL 14 | Homebrew services | Local databases | laptop run: `brew_services` | keep | A development database, not part of the agent workflow. |
| `com.eventus.fcc-server` | Old local model proxy | was its own plist | Was `~/.config/free-claude-code/` | removed 2026-07-31 | dismantle | Already retired; the laptop run confirms the plist and its 11.8 GB log folder are gone. |

Processes that the apps start themselves (OpenCode server on 47601, action-triage trigger server on 47600, Atlas dashboard on 8770) are features, judged in JP-97.

## Hooks

From the live settings as audited on 8 November 2026 (29 hook commands on 13 events) and `settings.example.json`. The laptop run lists the live hooks again (`claude_settings`).

| Item | What it is | Started by | Reads and writes | Last used | Verdict | Reason |
| --- | --- | --- | --- | --- | --- | --- |
| `atlas-hook.js` (claude-360) | Sends session events to Session Atlas | 8 events, every session | Hook input; posts to port 8770, spools on failure | laptop run | migrate | Becomes the ledger's recorder in josh-360's `hooks/` folder (JP-107, JP-111). |
| `atlas-removal-guard.js` (claude-360) | Blocks worktree removal until files are saved | PreToolUse Bash | Bash command; Atlas | laptop run | migrate | Fixes the "working files vanish" gap; moves with Atlas (JP-111). |
| `jira-link-hook.sh` (claude-360) | Links sessions to Jira tickets in the cost ledger | PostToolUse Bash | Bash command; writes `jira_session_links` | laptop run | migrate | Ticket links are ledger facts (JP-107). |
| `askHook.ts` (action-triage) | Sends Agent Manager questions to the Needs you tab | PreToolUse AskUserQuestion | Question store | laptop run | migrate | Moves with action-triage (JP-124). Its live path points into a worktree folder, which breaks when that worktree is pruned; JP-105 should point it at the main checkout. |
| `desk_guard.py` (action-triage desk) | Limits tools in desk worker sessions | PreToolUse, every tool call | Session env | laptop run | migrate | Moves with the desk (JP-124). |
| `agent-deck hook-handler` | Third-party session manager's hook, 7 events | live settings | Unknown (binary not inspected) | laptop run | dismantle | Agent Manager is the session manager now. Question 4. |
| `claude-remote-*` (5 hooks) | "Tactic Remote" pings, including every tool call | Notification, PreToolUse, PostToolUse, SessionStart, Stop | Post to port 8765 | laptop run: `listening_ports` | dismantle | Nothing known listens for them on 8765 (the focus dashboard has no handler), so they cost a call per tool use for nothing. Question 4. |
| `secret-redact-post-tool-use.sh` | Redacts secrets in Bash output | PostToolUse Bash | Tool output | live | keep | Safety net. |
| `post-compact-load-handoff.py` | Re-injects STATE.md after compaction; prunes old session-state | SessionStart compact | `session-state/` | live | keep | STATE.md is the one per-session record (JP-100). |
| `precompact_state_refresh.py` | Rewrites STATE.md before compaction (one Haiku call) | PreCompact | Transcript tail; writes STATE.md | live | keep | One small call per compaction, not per turn; it keeps STATE.md accurate (JP-100). |
| `compaction/save_summary.py` | Saves each compaction summary (keeps 20) | PostCompact | Writes `session-state/<id>/compactions/` | live | dismantle | A second per-session record beside STATE.md (JP-100). |
| `compaction/meter.py` | Context-size warnings | not wired | Transcript | never live | dismantle | Never wired; only tests call it. |
| `focus-*` and `session-focus-inject.sh` (5) | The focus loop | example settings only | `session-focus/` | not live | dismantle | Off live; STATE.md and the ledger replace focus files (JP-100). |
| `session-to-wiki.sh` | Copies finished transcripts into the Obsidian wiki staging folder | not wired | Transcripts; writes full copies | laptop run: staging folder size | dismantle | Not wired, and a copy of every transcript is what the ledger avoids. |
| `start-claude-mem-worker.sh` | Starts the claude-mem worker | not wired | — | not live | dismantle | claude-mem is off. |
| `precompact_write_handoff.py` | Old handoff writer | not wired (one function reused) | Writes `.planning/continue-here_*` | not live | dismantle | Replaced by STATE.md; keep the one function `precompact_state_refresh.py` imports. |
| `claude-keychain-auth-helper.sh` | Prints the Bifrost token from the keychain | `apiKeyHelper`, if set | Keychain | laptop run: `api_key_helper` | keep | Gateway sign-in for sessions. |
| `pr-review-changes-requested-reminder.sh` | Reminds to plan before fixing a changes-requested PR | UserPromptSubmit | Marker files | live | keep | Pairs with the review ceremony. |
| `claude-stop-failure-toast.py` | Desktop notice when a turn dies on an API error | StopFailure | Transcript title | live | keep | Cheap and useful; the ledger can record the same fact later. |
| superpowers session-start hook | Loads the superpowers skill list | plugin | — | live | keep | Planning and building method. |
| Status line (`ccstatusline`) | Terminal status line | settings | — | live | keep | Display only. |

## Plugins and MCP servers

| Item | What it is | Started by | Reads and writes | Last used | Verdict | Reason |
| --- | --- | --- | --- | --- | --- | --- |
| claude-mem plugin | Cross-session memory with a worker and Chroma | plugin (off live, on in the example) | Transcripts; its own database | laptop run: `~/.claude-mem` | dismantle | Off already; the ledger is the memory. Its 16 cached versions go on the deletion list. |
| context-mode plugin and marketplace copy | Context-saving plugin | not enabled | `~/.claude/context-mode/sessions/*.db` | 2026-03-23 | dismantle | Dormant for eight months. |
| superpowers | Skills library and hook | plugin | — | live | keep | Used in every build. |
| claude-md-management, feature-dev, playground, ponytail, atlassian | Other enabled plugins | plugins | — | live | keep | In use or cheap; JP-97 and later tickets can revisit. |
| Plugins only in `settings.example.json` (agent-sdk-dev, code-simplifier, codex, github, slack, builder-skills, skill-creator) | Example settings drift from live | example file only | — | not live | dismantle | Remove them from the example so it matches live; the github plugin also duplicates `gh`. |
| MCP server names in `~/.claude.json` | Servers such as claude-design and eventus-analytics | Claude Code | — | laptop run: `claude_settings[".claude.json"]` | keep | Names only here; each is judged where it is used. |

## Memory and transcript readers

The ledger (JP-107) becomes the one memory of sessions, with pointers into transcripts rather than copies.

| Item | What it is | Started by | Reads and writes | Last used | Verdict | Reason |
| --- | --- | --- | --- | --- | --- | --- |
| Session Atlas | Session index, focus summaries, files, links, costs | `com.eventus.claude-atlas` and its hook | Transcripts in place; `atlas.db` (5.2 GB) | laptop run | migrate | Onto the ledger (JP-111); most features kept (JP-97). |
| Atlas per-turn focus worker | One Haiku call per finished turn in sessions with focus on | Atlas service | Transcript deltas; `focus_states` | laptop run | dismantle | The vision retires per-turn model calls; summaries come once a session goes quiet (JP-108). |
| claude-mem | Plugin memory | plugin and worker | Transcripts | off | dismantle | See plugins. |
| Obsidian transcript staging | Full transcript copies for the wiki | `session-to-wiki.sh` (unwired) | Writes `~/Development/active/obsidian-wiki/raw/claude-sessions/` | laptop run | dismantle | The ledger keeps pointers instead. |
| context-mode databases | 35 small session-event databases | old plugin | `~/.claude/context-mode/sessions/` | 2026-03-23 | dismantle | Dormant; archive. |
| STATE.md | Per-session fact record | the agent and the compaction hooks | `~/.claude/session-state/<id>/STATE.md` (309 folders) | live | keep | The one per-session record (JP-100). |
| Session focus files | Per-session focus anchor | the agent, focus hooks | `~/.claude/session-focus/` | laptop run | dismantle | Overlaps STATE.md (JP-100). |
| Compaction summaries | Last 20 summaries per session | `save_summary.py` | `session-state/<id>/compactions/` | live | dismantle | Overlaps STATE.md (JP-100). |
| Handoff files | `continue-here` notes | `hand-off` skill, old hook | `.planning/` in projects and `~/.claude/.planning/archive/` | laptop run | dismantle | Replaced by STATE.md (JP-100). |
| Claude Code auto memory | Per-project `memory/MEMORY.md` | Claude Code | `~/.claude/projects/<slug>/memory/` | live | keep | Claude Code's own feature. |
| Agent memory folders | `agent-memory/` and `.agents/memory/` | Claude Code agent memory | small | laptop run | keep | Used by agents that declare memory; the orphan is handled below. |
| `agent-memory/dashboard-architect/` | Memory for an agent with no definition | — | 2 files | laptop run | dismantle | Orphan: no agent definition uses this memory. |
| Task-manager queue | One JSON file per to-do on OneDrive | `task-manager` skill | `.../claude_services/skills/task-manager/` | laptop run | dismantle | Tickets are the work item, and this is one more task list. Question 4. |
| Obsidian wiki vault and its skills | Long-term knowledge base | wiki skills, on demand | `$OBSIDIAN_VAULT_PATH` | laptop run | keep | Knowledge, not session memory. Question 2. |
| On-demand transcript readers (skills `find-conversation`, `recall`, `reflect`, `claude-history-ingest`, `show-me-your-work`, `cleanup-claude`, `automate-me`, `list-claude-processes`) | Read transcripts when asked | Josh or an agent | Transcripts | laptop run: `figures.skill_use` | keep | They read only when called; once the ledger exists they can start from it. |
| Decision logs (`show-me-your-work`) | Audit trail of unattended work | the skill | `decisions.tsv` in a work folder | laptop run | keep | Until decisions live in the ledger (JP-116). |

## Data stores

Sizes from the storage register of 8 November 2026 unless noted; the laptop run refreshes every one (`stores`).

| Item | What it is | Started by | Reads and writes | Last used | Verdict | Reason |
| --- | --- | --- | --- | --- | --- | --- |
| `~/.claude/projects/` (11.9 GB, about 4,455 transcripts) | Claude Code transcripts | Claude Code | Written by every session | live | keep | The source the ledger points into. Cleanup stays manual (`cleanup-claude`) until the ledger records pointers. |
| `~/.claude/atlas/atlas.db` (5.2 GB) | Atlas database | Atlas | Atlas | live | migrate | Onto the ledger (JP-111); 8 million file-candidate rows need a retention rule there. |
| `~/.claude/atlas/` backups (about 700 MB), spool (about 2,500 failed files) and log (314 MB) | Atlas side files | Atlas | Atlas | laptop run | dismantle | Archive after JP-111; the spool files are events that never posted. |
| `~/.claude/cost-ledger/ledger.db` (590 MB) | Token and cost per message | Atlas import runner | Transcripts; ledger | live | migrate | Cost records move with Atlas onto the ledger (JP-111). |
| Cost-ledger `.bak` and dry-run copies (about 1.5 GB) | Old copies | earlier migrations | — | laptop run | dismantle | Archive; deletion list. |
| `~/.claude/jobs/` (2.0 GB, no retention) | Claude Code background-session folders | Claude Code | — | live | keep | Claude Code's own; a retention rule is a later tidy. |
| `~/.claude/plugins/cache/` (11.6 GB) | Cached plugin versions | Claude Code | — | live | keep | Claude Code's own; old versions of switched-off plugins go on the deletion list. |
| `~/.claude/history.jsonl`, `file-history/`, `paste-cache/` | Prompt history and file snapshots | Claude Code | — | live | keep | Claude Code's own. |
| `~/.claude/session-state/` (24 MB) | STATE.md folders | hooks and agents | — | live | keep | See memory. |
| `~/.claude/sprint-state/` | Sprint lead and worker state | `sprint.py` | Agent Manager state, GitHub, Jira | laptop run | build new | Graph run state replaces it (JP-114, JP-128). |
| `~/.claude/deliverables/` (30 MB) | Files from `transcribe-social-post` | that skill | — | laptop run | keep | Small; Josh's rules retire `deliverables/` for new files, so the skill should move to the artifacts folder later. |
| `~/Library/Application Support/action-agent/` | Daemon state, questions, outbox, mailbox, review priority, archived session files | action-agent | — | live | migrate | Moves with action-triage onto the ledger (JP-124). |
| `~/Library/Application Support/action-triage/` | App state, prompt overrides | app | — | live | migrate | Moves with action-triage (JP-124). |
| `~/Library/Application Support/agent-services-desk/desk.db` | Desk ledger | desk scripts | — | laptop run | migrate | Moves with the desk and action-triage (JP-124). |
| Agent Command Center `server/data/meetings/` | `action-items.json`, Notion meeting data | meetings-sync, app | — | live | migrate | The last live part of Command Center; moves with JP-124. |
| `~/.claude/context-mode/` (3 MB) | Dormant databases | — | — | 2026-03-23 | dismantle | See memory. |
| `~/.claude-mem/` | claude-mem data and observer sessions | claude-mem | — | laptop run | dismantle | See memory. |
| Obsidian staging folder | Transcript copies, if any | `session-to-wiki.sh` | — | laptop run | dismantle | See memory. |
| `~/.config/free-claude-code/` | fcc-server logs | — | — | removed 2026-07-31 | dismantle | Confirm gone. |
| `~/.local/share/opencode/`, `~/.pi/agent/sessions/` | Other clients' session stores | OpenCode, Pi | read by the cost ledger | laptop run | keep | The cost records read them; they stay with those clients. |
| `~/.claude/daemon/`, `ccusage/`, `plans/`, `scheduled-tasks/`, `.playwright-cli/`, small caches | Claude Code and tool runtime files | various | — | live | keep | Small and owned by their tools. |
| Keychain items (Bifrost, Anthropic, GitHub App, Jira, Atlas, Athena) | Secrets | — | — | — | keep | Never read by this inventory. |

## Agent definitions

38 definitions in `~/.claude/agents/` (35 Markdown, 3 Codex TOML). "No caller" means no skill or rule names it (claude-harness `docs/harness/dependencies.md`); use counts come from the laptop run.

| Item | What it is | Started by | Reads and writes | Last used | Verdict | Reason |
| --- | --- | --- | --- | --- | --- | --- |
| `docs-sync-reviewer` | Fixes stale documentation | global rules | Docs | laptop run | keep | Required by Josh's global rules. |
| `web-researcher` | All web search and fetch | global rules | Web | laptop run | keep | Required by Josh's global rules; drop the stale claude-mem tools from its list. |
| `security-auditor` | Security audit | `pr-security-review`, `tasks-issue` | Code | laptop run | keep | Used by the PR security review. |
| `data-analyst` | Answers data questions | `equip-questions` and others | Databases | laptop run | keep | Has callers. |
| `comment-sicko` | Comment reviewer | `no-comments` | Code | laptop run | keep | Has a caller. |
| `code-debugger` | Diagnoses errors | on request | Code | laptop run | keep | General use. |
| `log-searcher` | Searches logs | on request | Logs | laptop run | keep | General use. |
| `issue-tracker` | Documents bugs found outside development, on request | on request | Notes | laptop run | keep | Josh's rules allow it when asked. |
| `project-folder-organizer` | Tidies a project folder | on request | Files | laptop run | keep | General use. |
| `tailwindadmin-ui-engineer` | Builds TailwindAdmin UI | on request | Code | laptop run | keep | Paired with the `tailwindadmin-ui` skill. |
| `foreman-analyst`, `foreman-scout`, `foreman-verifier`, `foreman-worker` | Roles for fable-foreman | fable-foreman | Code | laptop run | keep | A working orchestration pattern the graphs can learn from (JP-101). |
| `luna-sdd-worker`, `luna-sdd-reviewer` | Subagent-driven development roles | SDD runs | Code | laptop run | keep | Used by SDD runs. |
| `poteto-agent` | Routing target for poteto-mode | `poteto-mode` | Code | laptop run | keep | Has a caller. |
| `keystone-branch-reviewer` | Keystone branch review | on request | Code | laptop run | keep | Project-specific but live work. |
| `signature-standards-design-reviewer` | Keystone signature-standards review | on request | Code | laptop run | keep | Project-specific but live work. |
| `hl7-evidence-auditor` | HL7 receipt evidence audit | on request | Data | laptop run | keep | Work audits recur. |
| `email-manager` | Sends and drafts Outlook email | `tasks-email`, `tasks-todo` | Outlook | laptop run | keep | General mail helper; its Command Center callers go, it does not. |
| `code-simplifier` | Simplifies changed code | on request | Code | laptop run | keep | The duplicate is the example-only plugin, removed above. |
| `claude-optimizer` | Audits Claude config | no caller | Config | laptop run | keep | No caller, but Josh can call it directly; the 90-day count decides (appendix). |
| `code-quality-strike-team` | Whole-codebase audit | no caller | Code | laptop run | keep | No caller, but Josh can call it directly; the 90-day count decides (appendix). |
| `official-docs-finder` | Finds official docs | no caller | Web | laptop run | keep | No caller, but Josh can call it directly; the 90-day count decides (appendix). |
| `pr-high-effort-reviewer` | Deep review of one PR | no caller | Code | laptop run | keep | No caller, but Josh can call it directly; the 90-day count decides (appendix). |
| `prompt-optimizer` | Clarifies vague requests | no caller | — | laptop run | keep | No caller, but Josh can call it directly; the 90-day count decides (appendix). |
| `smart-brevity-author`, `smart-brevity-educator` | Writing styles | no caller | — | laptop run | keep | No caller, but Josh can call it directly; the 90-day count decides (appendix). |
| `tdd-testing-orchestrator` | Test-driven development runs | no caller | Code | laptop run | keep | No caller, but Josh can call it directly; the 90-day count decides (appendix). |
| `ui-ux-critic` | UI review | no caller | — | laptop run | keep | No caller, but Josh can call it directly; the 90-day count decides (appendix). |
| `notion-explorer` | Reads Notion | on request | Notion | laptop run | keep | Its client path no longer exists (8 November audit); fix the path rather than drop it. |
| `slack-task-updater` | Slack updates for Command Center tasks | no caller | Slack | laptop run | dismantle | Command Center is retired. |
| `task9-code-reviewer` | Review of Athena Task 9 tests | no caller | Code | laptop run | dismantle | A one-off for finished work. |
| `word-notion-comparator` | Compares a Word file with Notion | no caller | Files | laptop run | dismantle | A one-off. |
| `docs-researcher.toml`, `explorer.toml`, `reviewer.toml` | Codex profiles | Codex | — | laptop run | keep | Codex reads them; cheap to keep. |

## Skills

217 skill folders in `~/.claude/skills/`, plus 14 `twg` links, 8 test-workspace folders and 4 packaged files; `.agents/skills/` holds the six Paseo skills, `tailwindadmin-ui` and the same 14 links. Rows below are the skills with a reason to change, then one row for the rest.

| Item | What it is | Started by | Reads and writes | Last used | Verdict | Reason |
| --- | --- | --- | --- | --- | --- | --- |
| `tasks-email`, `tasks-issue`, `tasks-todo` | Work items from the Command Center queue | on request | Command Center | laptop run | dismantle | Command Center is retired; the desk and tickets replace it. |
| `action-triage-issue`, `report-harness-block` | File action-triage GitHub issues | on request | GitHub | laptop run | dismantle | action-triage's GitHub-issue path is legacy; Jira tickets are the work item. Switch off with action-triage's phase 8. |
| `session-transplant` | Moves a conversation into a fresh background session to escape fcc-claude | on request | Transcripts | laptop run | dismantle | fcc-claude and litellm are retired. |
| `focus` | Focus loop | on request, and Atlas turns focus on from it | `session-focus/` | laptop run | dismantle | Josh never calls it by hand; STATE.md and the ledger replace it (JP-100). |
| `task-manager` | OneDrive to-do queue | on request | OneDrive | laptop run | dismantle | Question 4. |
| `sprint` (and its waker and watchdog scripts) | Runs Jira tickets through lead and worker sessions | `/sprint` | Agent Manager, Jira, GitHub | laptop run | build new | Runs until the development graph replaces it (JP-115, JP-128). |
| `flow_resubmit` | Duplicate of `flow-resubmit` | on request | — | laptop run | dismantle | Two folders for one skill; keep `flow-resubmit`. |
| `cloud-pr-handoff` (laptop only, no SKILL.md) | Stray folder beside `pr-cloud-handoff` | — | — | laptop run | dismantle | It has no SKILL.md, so it never loads. |
| Test-workspace folders (8, `*-workspace`) | Skill eval scratch folders | skill-creator | — | laptop run | dismantle | Eval output, not skills; archive. |
| Packaged files (4, `.zip` and `.skill`) | Built skill packages | skill-creator | — | laptop run | dismantle | Build output; archive. |
| Obsidian wiki family (12) | Wiki ingest, query and gardening | on request | Wiki vault | laptop run | keep | Question 2. `claude-history-ingest` stops reading the staging folder once it is gone. |
| Paseo skills (6), in `skills/` and `.agents/skills/` | Paseo orchestration | on request | Paseo | laptop run | keep | Paseo is a possible future host for the graphs; the two copies are byte-identical, so one copy can be retired once Josh's skill-store rule says which. |
| `twg*` links (14) | Links to `~/.config/twg/skills` | — | — | laptop run | keep | Owned by another tool. |
| All other skills (about 190) | Method, Git and PR, data and Azure, Athena, email, writing, design, harness skills | on request | various | laptop run: `figures.skill_use` | keep | In use or cheap to keep; any with no use in 90 days is listed in the appendix and judged there. |

## Tools and scripts

| Item | What it is | Started by | Reads and writes | Last used | Verdict | Reason |
| --- | --- | --- | --- | --- | --- | --- |
| `tools/session-dashboard-server.py` | The focus dashboard | `com.eventus.focus-dashboard` | `session-focus/`, transcripts | laptop run | dismantle | Goes with the focus dashboard job. |
| `tools/focus_parse.py`, `tools/test_focus_files.py` | Focus helpers and tests | imported | — | — | dismantle | Go with the focus loop. |
| `tools/promote_*`, `tools/instruction-consolidation/` | One-time migration tools | by hand | Skill and instruction trees | laptop run | keep | Small; archive once their migrations are confirmed done. |
| `scripts/sync-live.sh` | Syncs the harness repository into `~/.claude` | by hand | Repo and live folder | laptop run | keep | How harness changes reach the laptop. |
| `scripts/cleanup-claude-projects.sh` | Deletes old transcripts (dry run by default) | by hand | `~/.claude/projects/` | laptop run | keep | Manual cleanup; the ledger's pointers will say what is safe to delete. |
| `docs/harness/generate_inventory.py` | Regenerates the harness register | by hand | `~/.claude` | 2026-11-08 | keep | Complements this script, which covers jobs and figures. |
| `bin/sync-opencode-agents.py` | OpenCode agent sync | its job | Agents | laptop run | dismantle | Goes with its job. |
| `commands/seq_tool.md`, `commands/apps.md`, `commands/save-session.md` | Slash commands | by hand | — | laptop run | keep | `save-session` uses the old handoff path; it changes with JP-100. |
| `scripts/laptop_inventory.py` (josh-360) | This inventory's laptop step | the JP-105 job `inventory`, once; or by hand | Reads only; writes its report to standard output or one new file | new | keep | The repeatable way to refresh this file. |

## Dismantling plan

Each item is switched off and archived, which is reversible and needs nobody. Permanent deletion waits for the phase 1 close (JP-120), where Josh approves one list. The archive folder is `~/Archive/josh-360-retired/<date>/<item>/` on the laptop, with a one-line `README` saying where the item came from and how to put it back.

| Item | Switch off | Archive | Deletion list (JP-120) |
| --- | --- | --- | --- |
| `com.eventus.acc-launch-spawner` | `launchctl bootout gui/$UID/com.eventus.acc-launch-spawner` | Move its plist from `~/Library/LaunchAgents/` | The plist; the Command Center server code once JP-124 has moved its data |
| `com.eventus.focus-dashboard` and its tools | bootout | Plist; `tools/session-dashboard-server.py`, `focus_parse.py`, `test_focus_files.py` | Those files |
| `com.jgilpatrick.claude-mem-worker`, claude-mem plugin and hook | bootout; plugin already off | Plist, `start-claude-mem-worker.sh`, `~/.claude-mem/` | `~/.claude-mem/`, 16 cached plugin versions |
| `com.eventus.qa-waker-watchdog` | bootout | Plist | Plist |
| `com.jgilpatrick.sync-opencode-agents` | Put `#` before its line in the startup manifest, then bootout | `bin/sync-opencode-agents.py` and the generated OpenCode agents | Generated agents |
| `com.josh.quicktasks`, `com.omnara.daemon` | bootout (after question 4) | Plists and data folders | Data folders |
| `com.eventus.fcc-server` | Already off | — | Confirm the plist and `~/.config/free-claude-code/` are gone |
| Tactic Remote hooks (5), agent-deck hooks (7) | Remove their entries from `~/.claude/settings.json` (back the file up first) | The hook scripts | The hook scripts |
| Focus hooks, `meter.py`, `session-to-wiki.sh`, `precompact_write_handoff.py` (keep the one imported function), `save_summary.py` | Remove from settings where wired | The scripts; `session-focus/`, the Obsidian staging folder, compaction summaries | Same |
| context-mode | Already off | `~/.claude/context-mode/`, `plugins/marketplaces/context-mode/` | Both |
| Atlas per-turn focus worker | Turned off in JP-111 (no focus activation) | — | — |
| Atlas backups, failed spool files, cost-ledger `.bak` copies | After JP-111 proves the ledger | Move to the archive | All of them |
| Example-only plugins | Remove from `settings.example.json` | — | — |
| Agents `slack-task-updater`, `task9-code-reviewer`, `word-notion-comparator`; orphan `agent-memory/dashboard-architect/` | Move out of `~/.claude/agents/` | Archive | Same |
| Skills `tasks-*`, `session-transplant`, `focus`, `flow_resubmit`, `cloud-pr-handoff`, test workspaces, packaged files | Move out of `~/.claude/skills/` | Archive | Same |
| Skills `action-triage-issue`, `report-harness-block` | With action-triage's phase 8 | Archive | Same |
| `task-manager` skill and its OneDrive queue (after question 4) | Stop using; move the skill | Archive the queue folder | Queue folder |

The harness changes go through claude-harness pull requests at the phase close, under Josh's rule that pull requests to his other repositories wait for it.

## Questions for the phase 1 sitting

Collected for JP-106, each with a recommendation. The verdicts above already take the recommended option, so nothing waits on these.

1. **Session Atlas's per-turn summaries.** Retire the Haiku call that runs after every turn in focus sessions? *Recommendation: yes, as the vision says; the ledger writes five lines when a session goes quiet (JP-108).*
2. **The Obsidian wiki.** Keep the wiki and its skills, with the transcript staging hook retired? *Recommendation: yes. The wiki holds knowledge, not session memory; if Josh no longer uses it, the twelve wiki skills move to the dismantle list.*
3. **OpenCode.** Is OpenCode still a client Josh uses directly? *Recommendation: retire the hourly agent sync (its models are retired) and keep OpenCode only as action-triage's chat engine.*
4. **Leftover tools.** Retire QuickTasks, Omnara, the agent-deck hooks, the Tactic Remote hooks and the task-manager queue? *Recommendation: yes for all five; each is a second copy of something Agent Manager, Claude Code or Jira already does. If any is still in daily use, say which and it stays.*
5. **The focus loop.** Retire the `focus` skill and focus files in favour of STATE.md? *Recommendation: yes, with JP-100.*
6. **Duplicated skill copies.** For the six Paseo skills present in both `skills/` and `.agents/skills/`, which copy is the real one? *Recommendation: `.agents/skills/`, as Josh's global rules describe; retire the other.*

## What the laptop run adds

The run (the JP-105 job `inventory`, which runs `scripts/laptop_inventory_job.py` once after the merge and puts its report on `laptop-status` as `reports/inventory.json`) returns, as names, paths, sizes and counts only. Run as a background job, it leaves out the folders macOS may guard with a privacy prompt (iCloud, OneDrive, Desktop, Documents, Downloads), including anything that reaches them through a symlink, so the one OneDrive store in the table above reads "skipped", and it does not run `brew`, which writes its own cache even to list services (Homebrew's services still show as `homebrew.mxcl.*` launchd plists):

- every launchd plist and whether launchd has it loaded, with its log file's size and last change (the "last used" column for jobs);
- the live hooks, plugins and MCP server names;
- every skill and agent definition, with 90-day use counts and last use;
- the size, file count and last change of every store above;
- listening ports and running program names;
- the starting figures.

A follow-up pull request then fills the "laptop run" cells that change a verdict, the appendix, and the laptop rows of `starting-figures.md`.

## Appendix: skills and agents with no recent use

Waiting for the laptop run. The list will be every skill folder and agent definition with no Skill call, slash command or agent call in the 90 days before the run (`definitions` against `figures.skill_use` and `figures.agent_use`), with the count first.

Known before the run, from the repositories: 13 agent definitions have no caller in any skill or rule (`claude-optimizer`, `code-quality-strike-team`, `hl7-evidence-auditor`, `keystone-branch-reviewer`, `official-docs-finder`, `pr-high-effort-reviewer`, `prompt-optimizer`, `signature-standards-design-reviewer`, `slack-task-updater`, `smart-brevity-author`, `smart-brevity-educator`, `tdd-testing-orchestrator`, `ui-ux-critic`), and two more are one-offs for finished work (`task9-code-reviewer`, `word-notion-comparator`). Having no caller is not the same as no use, because Josh and agents call them directly.
