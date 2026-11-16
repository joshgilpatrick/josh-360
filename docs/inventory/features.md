# Feature list: action-triage and Session Atlas

## Contents

- [How to read this](#how-to-read-this)
- [Answers to the ticket's three questions](#answers-to-the-tickets-three-questions)
- [action-triage features](#action-triage-features)
- [Session Atlas features](#session-atlas-features)
- [Where the two apps overlap](#where-the-two-apps-overlap)
- [Local data stores](#local-data-stores)
- [Questions for Josh](#questions-for-josh)
- [Sources](#sources)

Ticket: [JP-97](https://eventuswh-analytics.atlassian.net/browse/JP-97). Written 16 November 2026 from the code on `main` of `Eventus-Whole-Health/action-triage` (commit `a0cafc3`) and `joshgilpatrick/claude-360` (commit `2d0843f`). Nothing here moves code. The laptop's background jobs get their own verdicts in the laptop inventory (JP-96); this page judges the features those jobs provide.

## How to read this

Every row has exactly one verdict:

| Verdict | Meaning |
| --- | --- |
| Keep as is | The feature carries over unchanged when its code moves into josh-360. |
| Keep, move onto the ledger | The feature carries over, but reads and writes the ledger in place of its own store. |
| Merge with … | Another feature does the same job; the row names the survivor. |
| Retire | The feature is switched off and archived. The reason says what replaces it, or why nothing needs to. |

Keep is the default, because Josh plans to preserve most of both projects. The carrier is the ticket that does the work for that row. JP-124 moves action-triage into josh-360 and JP-111 moves Session Atlas, so most rows name one of those two. Anything retired is switched off and archived, never deleted; a permanent deletion waits for the phase's deletion list (JP-120, JP-129).

IDs are stable: `A` rows are action-triage, `S` rows are Session Atlas.

## Answers to the ticket's three questions

**Which features are retired, and what replaces each?**

| ID | Feature | Replaced by |
| --- | --- | --- |
| S3 | Session Atlas focus summaries (a Haiku call after every turn) | Five summary lines written once when a session goes quiet (JP-108), with STATE.md as the one live record (JP-100) |
| A3 | Calendar tab | The ticket creation graph's intake (JP-121). The meeting extraction itself is kept (A1). |
| A6 | To-do tab | The Tickets tab's Backlog view, once quick capture files a JP ticket (A5) |
| A10 | GitHub-issue sessions (pickup, comment resume, `status:*` labels) | Jira ticket pickup (A9) and the session Jira channel (A11) |
| A12 | Tasked tab and standalone issues | The Tickets tab (A8) |
| A13 | Nudge, redo and model change on an issue | The ticket versions: Start sets Queued again, the mailbox carries a nudge, the spec property carries the model (A8, A11) |
| A14 | Email-origin issues and the one-shot result email | The Email Research Desk (A27) |
| A15 | Sprint lead handoff and the Start lead button | The walker bound to Agent Manager (JP-117), when the sprint skill retires (JP-128) |
| A35 | The OpenCode server the app starts | Nothing. No code calls it: every model call in the app goes through the Bifrost one-shot client. |

Six of these (A3, A6, A10, A12, A13, A14) were already planned for removal in action-triage's own Jira roadmap (phase 8) and the console redesign approved on 6 November 2026. Josh 360 only confirms them.

**Which features duplicate each other across the two apps, and which copy survives?** Six pairs, each settled in [Where the two apps overlap](#where-the-two-apps-overlap): the session record (Atlas's index survives, as the ledger), session titles (one title set on the ledger), session-to-ticket links (ledger links), the files a session made (Atlas's artifact manager), Send to Background (Atlas's `claude --bg --resume`), and the transcript list (Atlas's index feeds action-triage's Sessions view). The seven ideas of a task collapse to the Jira ticket for work, Linear for personal work, and intake records that become tickets.

**Is any part of action-triage's older GitHub-issue path still in use?** Yes, but only as a drain, and it should retire on action-triage's own schedule.

- It is still the only path that starts headless sessions on its own. Jira pickup is built but off: the checked-in daemon plist sets `ACTION_TRIAGE_JIRA` to `0` and does not set `ACTION_AGENT_JIRA_PICKUP`. The installed copy on the laptop may differ; JP-96 confirms it there.
- Nothing in the app creates new issues any more. The draft form and the CLI file Jira tickets, the CLI's `issue` noun is gone, and email intake moved to the desk.
- Use is low. A search of every repository this session can see found 2 issues with the `action-triage` label created since 15 October 2026, the latest on 4 November.
- The pull request audit (A21) is **not** part of the issue path and is in heavy use: 49 pull requests labelled `review:ready-for-human` and 46 labelled `review:changes-requested` were opened since 1 November in the repositories this session can see.

So: keep the issue path running until action-triage's phase 7 turns Jira pickup on, let the open issues finish, then retire it in action-triage's phase 8, before or during the move (JP-124).

## action-triage features

### Intake and capture

| ID | Feature | What it does | Reads and writes | Verdict | Reason | Carrier |
| --- | --- | --- | --- | --- | --- | --- |
| A1 | Meeting sync and action-item extraction | `meetings-sync/refresh.py` copies meeting notes from Notion, writes transcripts and summaries, and asks Haiku for the action items in each summary. Runs as a launchd job. | Reads Notion and Bifrost. Writes `notion-data.json`, `action-items.json` and the meeting markdown folders. | Keep as is | The vision names a Notion action item as a ticket-creation input. Extraction is cheap, runs once per meeting and works. | JP-121 (feeds the ticket creation graph); the job itself is judged in JP-96 |
| A2 | Item classification and field prefill | Two cheap model calls per item: is it Josh's, can an agent act on it, is it clinical; and suggested ticket fields (summary, kind, repository, skills). Prompts are editable. | Reads the item and the skills folder; calls Bifrost. Writes nothing durable. | Merge with the ticket creation graph | These are the first steps of the ticket creation graph. Keeping two copies would let them drift. | JP-121 |
| A3 | Calendar tab | Lists meetings by day with their action items: draft a ticket, mark done, defer to To-do, dismiss, restore, snooze. | Reads `action-items.json`, `notion-data.json`, app `state.json`. Writes dispositions to `state.json`. | Retire | Replaced by the ticket creation graph's intake (JP-121). action-triage's approved console redesign already removes this tab. Timing is [question 2](#questions-for-josh). | JP-121, then JP-124 |
| A4 | Ticket drafting | The draft form and `ticket create` write one Jira create with the summary, description, Repository, Agent Status and the `action-triage.spec` property; the repository is checked first, and an unconfirmed create is searched for rather than retried. | Reads Jira field options. Writes a Jira issue; on `--from-item`, writes `ticket:<KEY>` on the item. | Keep as is | It is the safe write step every intake route needs, and it already speaks Jira. | JP-124; used by JP-121 |
| A5 | Quick capture | A global shortcut (Cmd+Alt+.) opens a small window to capture a to-do, with an optional screenshot or file. | Writes the `__todo__` bucket in `action-items.json` and `userData/screenshots/`. | Merge with ticket drafting | The console redesign points quick capture at a JP ticket in Not Started, so it becomes a front door to A4. | JP-124 |
| A6 | To-do tab | The inbox of captured to-dos that have not become work yet. | Reads and writes the `__todo__` bucket. | Retire | Replaced by the Tickets tab's Backlog view once quick capture files tickets (A5). Already planned in action-triage's phase 8. | JP-124 |
| A7 | Prompt settings | View, edit, test and reset the app's model prompts (classify, prefill, draft, session, audit). | Reads `prompts/` in the repo; writes overrides to `~/Library/Application Support/action-triage/prompts/`. | Keep as is | Josh tunes prompts without a code change. | JP-124 |

### Tickets and agent sessions

| ID | Feature | What it does | Reads and writes | Verdict | Reason | Carrier |
| --- | --- | --- | --- | --- | --- | --- |
| A8 | Tickets tab | Active and Backlog views of AD and JP tickets, a detail view, Start (sets Agent Status to Queued), the runner toggle and a Stuck count. | Reads Jira and the `__tickets__` records. Writes Agent Status and the `agent-manager` label. | Keep as is | It is the Jira-native view the redesign built to replace the issue tabs. | JP-124 |
| A9 | Jira ticket pickup (daemon) | Polls for Queued tickets, runs the start gate, prepares the `<KEY>-<slug>` branch, spawns a headless session, moves Agent Status and Jira status, detects the PR, concludes and cleans up. Off by default. | Reads Jira and GitHub. Writes Jira, git branches and worktrees, and `__tickets__` in the daemon's `state.json`. | Keep, move onto the ledger | Its run records are workflow-run facts the ledger is meant to hold. How it relates to the walker is [question 3](#questions-for-josh). | JP-124; JP-117 |
| A10 | GitHub-issue sessions | Picks up issues carrying an `agent-spec` and the `action-triage` label, starts and resumes sessions from owner comments, sets `status:*` labels, auto-resumes after a restart. | Reads GitHub issues and comments. Writes labels, comments and issue records in the daemon's `state.json`. | Retire | Replaced by Jira ticket pickup (A9) and the session Jira channel (A11). See the answer above for timing. | JP-124 (action-triage phase 8) |
| A11 | Session Jira channel | A per-session MCP server with `report`, `report_blocker` and `permission_host`; the daemon relays the outbox to Jira, keeps a mailbox per ticket, resumes on a reply, and posts the question thread at Done. | Writes `outbox/`, `mailbox/` and `questions/` beside the daemon's `state.json`, and Jira comments and fields. | Keep, move onto the ledger | Questions and answers are the decision records the ledger holds. Passing new ticket comments to sessions (JP-118) should build on this mailbox, not beside it. | JP-124; JP-118 |
| A12 | Tasked tab and standalone issues | Rows for tasked meeting items and for `action-triage` issues with no meeting behind them, with an expandable lifecycle. | Reads GitHub issues and the daemon's `state.json`. | Retire | Replaced by the Tickets tab (A8). Already planned in action-triage's phase 8. | JP-124 |
| A13 | Nudge, redo and model change on an issue | Nudge posts an owner comment that resumes the session; Redo closes the old issue and PR and opens a fresh issue; the Session tab rewrites the spec's `model:` line. | Writes GitHub comments, issues, labels and PR state. | Retire | Replaced by their ticket versions: Start sets Queued again, a mailbox message carries the nudge, and the spec property carries the model (A8, A11). Ticket Cancel and Redo are planned in the console redesign but not built yet (they need the phase 4 mailbox), so JP-124 builds them before this retires. | JP-124 |
| A14 | Email-origin issues and result email | Issues created from forwarded email, with one constrained result email sent through a single-tool MCP server. | Reads issue specs; sends one email to Josh. | Retire | Replaced by the Email Research Desk (A27). The desk README's cutover retires this path. | JP-124 |
| A15 | Sprint lead handoff | A Queued ticket labelled `agent-manager` is handed to the sprint lead with `sprint.py handoff`; Needs you offers a Start lead button. | Writes handoff records in `__tickets__`; runs `sprint.py` and `agent-manager`. | Retire | Replaced by the walker bound to Agent Manager (JP-117) once the sprint skill retires (JP-128). | JP-128 |
| A16 | Session spawning and its safety rails | Worktree and branch contract, Bifrost routing with the project's virtual key and model aliases, per-session GitHub token refreshed every minute, the guardrails hook, forced transcript saving, the turn cap. | Reads Key Vault, the Keychain and GitHub App keys. Writes temp token folders, worktrees and transcripts. | Keep as is | Every headless session needs it, and each rule records a real incident. | JP-124 |
| A17 | Session watchdog and recovery | Kills hung turns (no transcript, stalled, over the hard cap), sweeps orphan processes, demotes stranded records each poll and at boot, auto-resumes interrupted sessions once, caps preflight retries, names silent stops and API errors, and nudges a looping session every 40 turns. | Reads transcripts and processes. Writes block reasons, comments and records. | Keep as is | Its block reasons are free friction facts for JP-112. | JP-124; JP-112 reads it |
| A18 | Daemon self-checks | Restarts itself when its own code changed and it is idle, logs a heartbeat every poll, exits on a stalled poll so launchd restarts it, and bounds the Key Vault read at launch. | Reads source file times. Writes `/tmp/action-agent.log`. | Keep as is | Each check fixed an outage where the daemon looked alive and did nothing. | JP-124 |
| A19 | Diagnose a stuck session | One button starts a fresh background session to find why a tasked item went wrong and fix the app. | Reads the item, its transcript and its worktree. Starts `claude --bg`. | Keep as is | On demand and cheap; the weekly review (JP-127) covers patterns, this covers one case. | JP-124 |
| A20 | Open in terminal and Send to Background | Opens a session in Ghostty for Josh, or hands it to Claude Code's background supervisor. | Writes a supervisor job file; starts Ghostty. | Merge with Session Atlas's Send to Background | Both apps send a session to the background. Atlas's `claude --bg --resume` uses the public command rather than the supervisor's files. Open in terminal is kept. | JP-124 |

### Pull request audit

| ID | Feature | What it does | Reads and writes | Verdict | Reason | Carrier |
| --- | --- | --- | --- | --- | --- | --- |
| A21 | Automated PR audit | Finds PRs labelled `review:needs-agent-audit` in every configured org, runs a security and simplification review in a prepared worktree, posts one consolidated comment and a verdict label, recovers a stalled audit, and hands a blocked one to Josh. | Reads GitHub PRs. Writes labels, comments, worktrees and PR-audit records in the daemon's `state.json`. | Keep as is | Heavily used (see the answer above) and PR-native. It becomes the review step of the development graph. It is josh-360's only reviewer: Josh chose it on 16 November 2026 ([question 1](#questions-for-josh)). | JP-124; JP-115 |
| A22 | Code Review board | A Tasks sub-tab of every open PR with a `review:*` label, in lanes, with the real queue order, reordering, a stuck flag and Force review. | Reads GitHub and the daemon's `state.json`. Writes `review-priority.json` and PR labels. | Keep as is | It is the one place Josh sees and orders the review queue. | JP-124 |

### Needs you

| ID | Feature | What it does | Reads and writes | Verdict | Reason | Carrier |
| --- | --- | --- | --- | --- | --- | --- |
| A23 | Needs you tab and the question hook | A user-level hook catches `AskUserQuestion` in Agent Manager and ticket sessions, shows the question as a card, notifies Josh, and sends his pick back so the session continues; it also lists Stuck tickets. The pill shows the count. | Writes and reads `questions/` beside the daemon's `state.json`; reads Jira for Stuck tickets. | Keep, move onto the ledger | Josh chose it as the one place for agent decisions. His answers are the first decision records (JP-116) and later feed suggestions (JP-126). | JP-125; JP-116, JP-126 |

### Log tabs

| ID | Feature | What it does | Reads and writes | Verdict | Reason | Carrier |
| --- | --- | --- | --- | --- | --- | --- |
| A24 | History tab | A lifecycle timeline per item from GitHub, the daemon's records and the transcript, with the files the session made; archives a worktree's files before it is pruned. | Reads GitHub, `state.json` and transcripts. Writes `session-files/` beside the daemon's `state.json`. | Keep, move onto the ledger | The timeline is ledger facts. Its file list merges into Atlas's artifact manager (S11), which keeps files without copying them. | JP-124 |
| A25 | Activity tab | A feed of the last 500 events (session started, PR opened, blocked, concluded, audit started and done) with read marks. | Reads GitHub and the daemon's records. Writes `activity.json`. | Keep, move onto the ledger | Each event is a run or step fact the walker writes to the ledger anyway. Today it is keyed by issue number and needs the ticket key. | JP-124 |
| A26 | Sessions catalog | A Log sub-tab of every transcript active in the last 30 days, with search, sort, transcript view and Send to Background. | Reads `~/.claude/projects/*/*.jsonl` and supervisor job files. | Merge with Session Atlas's session index | Atlas already indexes every session with lineage and cost (S1). This view reads the ledger instead of scanning transcripts itself. | JP-124 |

### Email Research Desk

| ID | Feature | What it does | Reads and writes | Verdict | Reason | Carrier |
| --- | --- | --- | --- | --- | --- | --- |
| A27 | Email Research Desk | Every minute a watcher looks for mail Josh forwarded, files a Jira ticket, hands it to a worker session, guards the worker's tool calls, and replies on the thread to Josh only. Installed outside the repo. | Reads Outlook. Writes `desk.db`, Jira tickets and replies to Josh. | Keep as is | It replaced the email-issue path and works. Its intake becomes one route into the ticket creation graph. | JP-124; JP-121 |
| A28 | Desk tab | A read-only list of the desk's threads, stage, ticket, worker and reply status. | Reads `desk.db` read-only. | Keep as is | Josh's view of the desk. | JP-124 |

### Developer command line and the app shell

| ID | Feature | What it does | Reads and writes | Verdict | Reason | Carrier |
| --- | --- | --- | --- | --- | --- | --- |
| A29 | Developer CLI | `action-triage <noun> <verb>` mirrors the app: `todo`, `ticket create`, `session list`, `session show`, `session trigger`, `schema --json`, with `--yes`, `--dry-run`, `--json` and fixed exit codes. | Same stores as the app; Jira through the launcher. | Keep as is | It is how agents drive the app. The `todo` noun goes when the To-do tab does (A6). | JP-124 |
| A30 | Pill window and panel | The always-on-top pill on the screen edge that slides out into the tabbed panel, with tray menu and notifications. | Reads every store above. | Keep as is | It is the app. | JP-124 |
| A31 | Phone bridge | An opt-in, token-protected HTTP bridge that serves the panel as a web app, for example over Tailscale. Off by default. | Reads and writes through the app's own handlers; writes `web-token.txt`. | Keep as is | Off by default and costs nothing; useful when away from the desk. | JP-124 |
| A32 | Packaged app and installers | The signed macOS package and the scripts that install the app and daemon as launchd jobs. | Writes the LaunchAgents plists. | Keep as is | How the app reaches the laptop. Start-up joins the one startup list. | JP-124; JP-119 |
| A33 | Bifrost request labels | Wraps every CLI the app launches so requests reaching Bifrost carry repo, branch and folder labels. | Reads the label helper from the bifrost-migration checkout. | Keep as is | Cost attribution by repo and branch; the cost ledger can reconcile against it. | JP-124 |
| A34 | GitHub label scripts | `setup-github-labels.sh` and `sync-labels.sh` create the label taxonomy in each repo. | Writes GitHub labels. | Keep as is | The `review:*` labels stay. The `status:*` and `type:*` issue labels go with A10. | JP-124 |
| A35 | OpenCode server | The app starts `opencode serve` on its port plus one at launch, with an OpenCode agent file in `opencode/`. | Starts a process. | Retire | Nothing replaces it, and nothing needs to: no code in `src/` calls the server, and every model call goes through the Bifrost one-shot client. | JP-124 |

## Session Atlas features

| ID | Feature | What it does | Reads and writes | Verdict | Reason | Carrier |
| --- | --- | --- | --- | --- | --- | --- |
| S1 | Session index | Nine Claude Code hooks post event metadata to the local service (spooled when it is down); the service records every session with its folders, status, start and end, and closes sessions idle for 12 hours. | Reads hook events and transcripts. Writes `sessions`, `events_seen`, `transcript_checkpoints` and `spool/`. | Keep, move onto the ledger | The vision makes it the ledger's starting point. | JP-107; JP-111 |
| S2 | Session lineage and titles | Links subagents and resumed sessions to their root, and picks a title: a custom title first, then Claude's own, then a fallback. | Reads transcripts. Writes `session_lineage`, `title_scan_jobs` and session titles. | Keep, move onto the ledger | Lineage and titles are fields of one ledger session. The cost ledger keeps a second set of titles (S8); the ledger keeps one. | JP-107; JP-111 |
| S3 | Focus summaries | After every turn of an active session, a Haiku call rewrites the session's title, summary and task list. Sessions become active when they use plan mode, `TaskCreate`, `/focus` or a brainstorming or planning skill. Includes the focus on/off switch, the dry run and the provider presets. | Reads trimmed transcripts. Writes `focus_states`, `worker_jobs` and session summaries; reads the `claude-atlas` Keychain item. | Retire | Replaced by five summary lines written once when a session goes quiet (JP-108) and STATE.md as the one live record (JP-100). Josh accepted this on 15 November 2026: no model runs per turn. | JP-108 (replacement); JP-111 (switch off) |
| S4 | Dashboard | Cost at a glance, sessions in motion, recent artifacts, Needs attention and worker status, at `127.0.0.1:8770`. | Reads `atlas.db` and the cost cache. | Keep, move onto the ledger | Its panels read ledger rows. "Focus sessions in motion" shows the JP-108 summary lines in place of focus summaries. The phase 3 dashboard (JP-131) may later absorb it. | JP-111 |
| S5 | Sessions grid and session page | Search, filter and sort every session; open one to see its transcript, lineage, cost, artifacts and resume folder. | Reads `atlas.db`, the cost ledger and transcripts. | Keep, move onto the ledger | The main way to find a past session, ticketed or not. | JP-111 |
| S6 | Needs attention | Lists sessions whose focus job is blocked or stale, quarantined jobs and missing resume folders, with dismiss and retry. | Reads `worker_jobs` and `sessions`. Writes `attention_acks`. | Keep, move onto the ledger | Its job and folder reasons are system health and stay. Its two focus reasons go with S3. It stays separate from Needs you, which holds decisions for Josh. | JP-111 |
| S7 | Send to Background | Checks the session id, transcript and folder, then runs `claude --bg --resume <id>` in that folder. | Starts `claude`. | Keep as is | The survivor for both apps (A20): it uses the public command. | JP-111 |
| S8 | Cost ledger | `npm run costledger` imports token use from Claude Code, OpenCode and Pi, prices it from explicit price rows, reprices on change, and reports by repo, branch, tool, model, day or session tree; reconciles against Bifrost; records session names and PR links; serves the 45-day session overview. | Reads transcripts, the Pi folder and the OpenCode database. Writes `~/.claude/cost-ledger/ledger.db`. | Keep, move onto the ledger | It is the cost half of the ledger already, and the vision makes it a starting point. The data model (JP-99) decides whether it stays a separate file. | JP-99; JP-107; JP-111 |
| S9 | Hourly cost import and cost cache | The service imports into the cost ledger at start and every hour, and refreshes a small cost copy for lists. | Runs the S8 import. Writes `session_cost_cache` in `atlas.db`. | Keep as is | It keeps cost current with no one remembering to run it. | JP-111; JP-119 |
| S10 | Jira session links | A Bash hook records which session worked on which Jira issue when a Jira command names it; `jira-cost` totals an issue's cost. | Writes `jira_session_links` in the cost ledger. | Merge with the ledger's session links | The ledger's session entry holds ticket links, derived the vision's way. The `jira-cost` report is kept on top of it. | JP-107 |
| S11 | Artifact manager | Catalogs the documents sessions make: one row per document with its locations, versions and evidence; coverage of every scanned folder; preview, export and a hidden-by-default view of protected documents. Built and measured on Linux; the macOS gates are still open. | Reads session folders, git checkouts and registered output folders, never protected file content. Writes the `artifact_*` tables in `atlas.db`. | Keep, move onto the ledger | It is the survivor for "files a session made" (A24) and the base for fixing pipeline gap 3, working files vanishing at cleanup. | JP-111 |
| S12 | Durable output folder | `npm run artifacts -- output-dir` gives each repository a private, registered folder outside the checkout; `register-output` adds folders to scan. | Writes `~/.claude/artifact-output/<repository-uuid>/deliverables/`. | Keep as is | Files written there outlive the worktree. The development graph should send working files there. | JP-111; JP-115 |
| S13 | Worktree removal guard | A `PreToolUse` hook on Bash blocks `git worktree remove` unless a read-only check finds nothing at risk, and blocks `--force` and `rm` of a worktree. | Reads the catalog and session state. Writes nothing. | Keep as is | It stops the loss gap 3 describes. The closeout agent (JP-109) should run the same check before it offers to remove a leftover worktree. | JP-111; JP-109 |
| S14 | Older file list | The first artifact table, filled from hook-reported writes, with its backfill. | Writes `artifacts`, `artifact_origins`, `artifact_candidates`. | Merge with the artifact manager | The artifact manager adopts these rows (`artifact_identity_adoptions`). JP-111 confirms nothing still reads the old table before switching it off. | JP-111 |
| S15 | Project names | Names a session's project from its git remote, then its git top folder, then the folder, with configurable aliases and a recompute command. | Reads git. Writes session project names. | Keep, move onto the ledger | It is the first rule of "how a session finds its home". | JP-107 |
| S16 | Service plumbing | The launchd service and its installer, the hook installer, the health endpoint, migrations with a backup check before destructive ones, the ledger preflight, the benchmark seed and the browser tests. | Writes the LaunchAgents plist, `~/.claude/settings.json` hook entries and `atlas.log`. | Keep as is | How Atlas runs and is checked. Start-up joins the one startup list. | JP-111; JP-119 |

## Where the two apps overlap

| Overlap | Copies today | Survivor |
| --- | --- | --- |
| What a session is | Atlas's session index (S1); the cost ledger's session tree and names (S8); action-triage's daemon records for the sessions it spawns (A9, A10); action-triage's Sessions catalog (A26); the desk's worker records (A27) | One ledger session entry keyed by tool and session id, built from S1 and S8. The daemon's records become workflow-run and step rows linked to that entry. A26 reads the ledger. |
| What a task is | Meeting action item (A1), to-do (A5, A6), GitHub issue (A10), Jira ticket (A8, A9), desk email thread (A27), focus subtask (S3). Outside these apps: Linear tickets and task-manager tasks (JP-96). | The Jira ticket for any work with a deliverable; Linear for personal work, designed in phase 3. Action items, to-dos and forwarded emails are intake that becomes a ticket. GitHub issues and focus subtasks retire. A PR audit is a run record about a PR, not a task. |
| Session titles | Atlas's title choice (S2) and the cost ledger's `session_labels` (S8) | One title on the ledger session, using S2's order (custom title first). |
| Session to ticket | Atlas's Jira session links (S10), the daemon's `__tickets__` records (A9) and the desk ledger's ticket column (A27) | The ledger's session links (JP-107). |
| Files a session made | action-triage's file list and `session-files/` archive (A24), Atlas's older file list (S14) and artifact manager (S11) | The artifact manager (S11), with the durable output folder (S12). |
| Send to Background | action-triage writes a supervisor job file (A20); Atlas runs `claude --bg --resume` (S7) | S7, recorded in `docs/decisions.md`. |
| What a session is doing now | Atlas's focus summary (S3), the harness's `/focus` file (JP-96, JP-100) and STATE.md | STATE.md while it runs; five summary lines once it goes quiet (JP-108). |
| Where Josh is asked | Needs you (A23), issue comments with `status:blocked` (A10), Atlas's Needs attention (S6) | Needs you plus a Jira flag on the ticket, as Josh decided. Needs attention stays as system health, recorded in `docs/decisions.md`. |
| Who reviews a PR | The action-triage audit (A21) only (`docs/WORKFLOW.md` §4) | Answered: [question 1](#questions-for-josh). |
| What starts a session for a ticket | Jira pickup (A9), the sprint lead (A15), and the walker with Agent Manager (JP-117) | The sprint lead retires (A15). Pickup versus walker is [question 3](#questions-for-josh). |

## Local data stores

These feed the data model (JP-99). Paths are the defaults on Josh's laptop.

### action-triage

| Store | Path | Written by | Holds |
| --- | --- | --- | --- |
| Action items | `~/Development/active/josh_projects/agent_command_center/server/data/meetings/action-items.json` and its `.lock` | meetings-sync and the app | Action items per meeting and the `__todo__` bucket |
| Meeting data | `notion-data.json` in the same folder, and `josh_projects/meetings/YYYY-MM-DD/` | meetings-sync | Notion sync state, transcripts and summaries |
| App state | `~/Library/Application Support/action-triage/state.json` | the app | Per-meeting dispositions, snooze and done marks |
| Activity feed | `~/Library/Application Support/action-triage/activity.json` | the app | The last 500 events and read marks |
| Prompt overrides | `~/Library/Application Support/action-triage/prompts/` | the app | Josh's edited prompts |
| Screenshots | the app's `userData/screenshots/` | quick capture | Screenshots attached to to-dos |
| Daemon state | `~/Library/Application Support/action-agent/state.json` | the daemon | Issue session records, PR-audit records, `__tickets__` (ticket and handoff records) and `__startAttempts__` |
| Questions | `questions/` beside the daemon's `state.json` | the ask hook, the app and the daemon | One file per question and its answer |
| Session outbox | `outbox/<session>.jsonl` and `.relayed.json` beside it | ticket sessions and the daemon | Progress notes and blockers, and what was relayed |
| Ticket mailbox | `mailbox/<KEY>.jsonl` and `.state.json` beside it | the daemon | Messages, questions and answers per ticket |
| Review priority | `review-priority.json` beside it | the Code Review board | Josh's order for the audit queue |
| Archived session files | `session-files/<repo>/issue-<n>/` beside it | the daemon | Files copied out of a worktree before pruning |
| Phone bridge token | `web-token.txt` beside the app's `state.json` | the app | The bridge's bearer token |
| Desk ledger | `~/Library/Application Support/agent-services-desk/desk.db` | the desk scripts | Email threads, replies sent, idle workers |
| Logs | `~/Library/Logs/action-triage/`, `/tmp/action-agent.log` | the app and the daemon | Operational logs |

It also writes outside the laptop: GitHub labels, comments and PR state, and Jira statuses, Agent Status, Flagged, comments and the `action-triage.spec` property.

### Session Atlas

| Store | Path | Written by | Holds |
| --- | --- | --- | --- |
| Atlas database | `~/.claude/atlas/atlas.db` | the service | Sessions, lineage, transcript checkpoints, events seen, focus states, worker and title jobs, attention dismissals, the old file list, the artifact manager's tables, the cost cache, Pi session ids, the backup manifest and migrations |
| Hook spool | `~/.claude/atlas/spool/` | the hook | Events the service could not take at the time |
| Config and logs | `~/.claude/atlas/config.json`, `atlas.log`, `launchd.out.log`, `launchd.err.log` | Josh and the service | Settings and logs |
| Cost ledger | `~/.claude/cost-ledger/ledger.db` | the `costledger` CLI | Messages, prices, pricing runs, cost rows, repos, session tree, names, PR links, Jira links, scan marks |
| Durable output | `~/.claude/artifact-output/<repository-uuid>/deliverables/` | sessions, through `output-dir` | Files that must outlive a worktree |
| Keychain item | `claude-atlas` | Josh | The focus worker's model credential; goes with S3 |

## Questions for Josh

For the phase 1 question sitting (JP-106). Each has a recommendation; nothing waits on them now.

1. **Who reviews josh-360's pull requests?** josh-360's rules have a cloud review thread review each PR (`docs/WORKFLOW.md` §4), and action-triage's daemon audits every PR with the same `review:needs-agent-audit` label in any configured org. `joshgilpatrick` is a configured org and the GitHub App is now installed there: this page's own PR (#4) got both reviews on 16 November 2026. *Recommendation:* one reviewer per PR. The cloud review thread reviews josh-360 until the development graph (JP-115) settles a single review step; the daemon gets a list of repositories its audit skips (a small action-triage change, which waits for the phase close like every PR to that repository), and josh-360 goes on that list. *Other route:* let the daemon review josh-360 and drop the review thread. **Answered 16 November 2026:** Josh chose the other route. The laptop audit reviews every josh-360 PR; there is no cloud review thread and no PR review watcher (`docs/decisions.md`, JP-141).
2. **Where do meeting action items go once the Calendar tab is gone?** The console redesign removes the Calendar and To-do tabs but does not say where Notion action items are triaged. *Recommendation:* keep the Calendar tab until the ticket creation graph (JP-121) is built; then each extracted item becomes a proposed ticket through that graph, and the tab retires.
3. **Does the daemon's Jira pickup become the walker's headless runner?** Both start a session for a Queued ticket: the daemon by itself, the walker through Agent Manager (JP-117). *Recommendation:* yes. Keep one pickup: the daemon asks the walker for the next step and starts the session the walker names, so the graph stays independent of the tool that runs it and headless runs keep the daemon's watchdog and safety rails.

## Sources

- action-triage `AGENTS.md`, `desk/README.md`, `meetings-sync/README.md`, `docs/superpowers/plans/2026-10-28-jira-migration-roadmap.md`, `docs/superpowers/specs/2026-11-05-console-redesign-design.md`, `scripts/com.eventus.action-agent.plist`, and `src/` (tabs from `src/renderer/Panel.tsx`, stores from `src/main/index.ts`, `src/core/config.ts`, `src/main/webConfig.ts`, `src/orchestrator/orchConfig.ts`).
- claude-360 `AGENTS.md`, `README.md`, `docs/costledger.md`, `hooks/`, and `src/` (tables from `src/db/` and `src/costledger/db.ts`, focus activation from `src/ingest/activation.ts`).
- Use counts: GitHub searches run on 16 November 2026 over the repositories this session can read (`label:action-triage is:issue created:>2026-10-15`; `is:pr label:review:ready-for-human created:>2026-11-01`; `is:pr label:review:changes-requested created:>2026-11-01`).
- `docs/vision-and-roadmap.md` for the decisions already made.
