# Unified data model: design

## Contents

- [Summary](#summary)
- [The ticket's four questions, answered](#the-tickets-four-questions-answered)
- [Storage](#storage)
- [The append-only rule](#the-append-only-rule)
- [Identity: machines, sessions and runs](#identity-machines-sessions-and-runs)
- [The tables](#the-tables)
- [How a session finds its home](#how-a-session-finds-its-home)
- [Where each overlap lands](#where-each-overlap-lands)
- [What moves in from today's stores](#what-moves-in-from-todays-stores)
- [Who writes what](#who-writes-what)
- [Patient data](#patient-data)
- [Loose ends are computed, never stored](#loose-ends-are-computed-never-stored)
- [Queries agents may call](#queries-agents-may-call)
- [The query that replaces a changelog file](#the-query-that-replaces-a-changelog-file)
- [What the measures read](#what-the-measures-read)
- [Expected size and retention](#expected-size-and-retention)
- [Rules](#rules)
- [Acceptance criteria](#acceptance-criteria)
- [Out of scope](#out-of-scope)
- [Choices made](#choices-made)
- [Questions for Josh](#questions-for-josh)

Ticket: [JP-99](https://eventuswh-analytics.atlassian.net/browse/JP-99). Draft schema: `ledger/schema.sql`, tested by `tests/test_ledger_schema.py`. Code lists: `ledger/codes.json`. Build plan: `docs/superpowers/plans/2026-11-16-ledger.md` (JP-107). Written 16 November 2026 from the vision, the laptop inventory (JP-96), the feature list (JP-97), the graph convention (JP-101, JP-139, JP-140), the three graph designs (JP-102, JP-103, JP-104), Session Atlas's two databases (claude-360 at `2da83a3`) and action-triage's daemon state (at `7785e6d`).

## Summary

The ledger is one SQLite database on the laptop, `~/.josh-360/state/ledger.db`. It holds facts about sessions, graph runs and Josh's decisions. Rows are only ever added: a database trigger refuses every edit and every delete, and a wrong row is withdrawn by adding a correction. Big, rebuildable working tables (the cost importer's per-message rows, prices and the file catalog) sit beside it in a second file, `cache.db`, so the record that matters stays small enough to back up daily and keep forever.

Thirty-one tables in all. Twenty-five answer six groups of questions:

| Group | Tables | Main question it answers |
| --- | --- | --- |
| Sessions | `sessions`, `session_lineage`, `session_episodes`, `session_refs` | Which sessions ran, where, on which branch, and what they touched |
| Homes and links | `ticket_links`, `session_homes` | Which ticket, epic and priority each session belongs to |
| Cost and summaries | `session_costs`, `model_calls`, `session_summaries`, `session_state_notes` | What a session cost, and what it was about |
| Friction | `session_facts`, `session_usage`, `debriefs`, `debrief_moments` | Where the system let Josh down |
| Graph runs | `graph_runs`, `step_runs`, `step_results`, `run_files`, `run_ends`, `comment_deliveries` | What each graph did, step by step, and how each run ended |
| Decisions | `asks`, `decisions`, `decision_events`, `category_stages`, `memory_lookups` | What Josh was asked, what he answered, and where it applies |

Six more keep the rest honest: `machines`, `schema_migrations`, `corrections` and `redactions`, and two that record Josh's own marks, `ticket_offers` and `branch_marks`.

Nothing here stores transcript text, message text or file contents, and nothing stores a loose end. Tickets stay in Jira and Linear; the ledger holds only their keys.

## The ticket's four questions, answered

**One database file, or one per concern?** Two files, one schema. `ledger.db` holds the facts and is append-only. `cache.db` holds working tables that can be rebuilt from the transcripts and the repository: the cost importer's per-message rows and prices, scan marks, and Session Atlas's file catalog. One file per concern (sessions, runs, decisions, cost) was rejected: nearly every useful question joins two of them, and the vision asks for one ledger. One file for everything was rejected too: the cost import alone is 635 MB and re-prices rows in place, which an append-only file cannot do, and a daily backup of it would be large. This is [question 1](#questions-for-josh).

**Which fields of Session Atlas's session index and cost records carry over unchanged?**

- *Unchanged into `cache.db`:* the cost ledger's whole message import, every column of `messages`, `models`, `model_aliases`, `prices`, `pricing_runs`, `message_costs`, `import_runs`, `source_files`, `repos`, `label_scans`, `message_holders`, `claude_spawn_owners`, `session_nodes` and `session_links`. The importer keeps working as it does.
- *Unchanged into `ledger.db`, under new names:* a session's tool and id, `started_at`, `transcript_path` and `start_cwd` (as `sessions.start_folder`); `last_activity_at`, `ended_at` (as `quiet_at`), `end_reason`, `resume_cwd` (as `folder`) and the title with its source (`session_episodes`); `session_lineage`'s parent, root and confidence; the cost ledger's `session_labels` (as the title source), `session_pr_links` (as `session_refs` of kind `pr`) and `jira_session_links` (as `ticket_links`).
- *Not carried over:* the focus fields (`summary`, `focus_state`, `focus_activated_at`, `focus_activation_source`), `status` (worked out from episodes), `project_name` (the home's `system` replaces it), `created_at` and `updated_at` (nothing is updated), and the cost cache (`session_cost_cache`), which the ledger's `current_session_costs` view replaces.

**How is a session from a second machine told apart later?** Every ledger has one `machines` row, made when the database is created, with a random `machine_id`. Every session's key is `<machine_id>:<tool>:<tool's session id>`, and every graph run names its machine. Two ledgers can then be merged into one with no key clashing; the merge itself is designed in phase 3 (JP-132).

**Which ledger query replaces a per-project changelog file?** `ledger/ask.py changes --system <name> --since <date>`: the sessions in that system that committed or opened a pull request, newest first, each with its date, ticket, pull request and the first line of its summary. See [The query that replaces a changelog file](#the-query-that-replaces-a-changelog-file).

## Storage

| | `ledger.db` | `cache.db` |
| --- | --- | --- |
| Holds | Facts: sessions, homes, cost per session, summaries, friction, runs, decisions | The cost import's per-message rows and prices, scan marks, the file catalog, Atlas's job queues |
| Rule | Append-only, enforced by triggers | Ordinary tables; may be deleted and rebuilt |
| Location | `~/.josh-360/state/ledger.db` | `~/.josh-360/state/cache.db` (JP-111 moves Atlas's and the cost ledger's files here; until then the recorder reads `~/.claude/cost-ledger/ledger.db` read-only) |
| Backup | Daily, compressed, kept locally: 14 daily and 8 weekly copies in `~/.josh-360/backups/` | None: it is rebuilt from transcripts and the repository |
| Kept | For ever (see [Expected size and retention](#expected-size-and-retention)) | Per-message rows for 90 days after their session's cost is copied into the ledger |

**Engine.** SQLite, through Python 3.9's standard `sqlite3` module, because laptop code runs on `/usr/bin/python3` with the standard library only (`.claude/workflow.config.md`, Deploy). It needs no server, no install and no network. The schema uses nothing newer than SQLite 3.31: no `STRICT` tables and no `RETURNING`. Every connection turns on `PRAGMA foreign_keys` and `PRAGMA recursive_triggers` (without the second, `INSERT OR REPLACE` removes the old row without firing its delete trigger, a hole in the append-only rule), uses write-ahead logging (`journal_mode = WAL`) so the walker and the recorder can write at the same time, and waits up to five seconds for a lock (`busy_timeout`).

**Backup.** A daily job, `ledger-backup` in `jobs.yaml`, copies the live database with SQLite's own backup call (safe while others write), runs `PRAGMA integrity_check` on the copy, compresses it with gzip and keeps the newest 14 daily and 8 weekly copies. To restore: stop the jobs with `laptop/pause.py on`, unzip the chosen copy over `ledger.db`, and resume. Copies stay on the laptop, like the ledger; an off-laptop copy is [question 3](#questions-for-josh).

**Schema versions.** `PRAGMA user_version` holds the version, and `schema_migrations` lists every migration applied. `ledger/schema.sql` builds a new database at the current version. Each later change is a numbered file, `ledger/migrations/NNNN-<name>.sql`, applied in order by the install script (JP-105's `laptop/install.py`) after a backup. A migration may only add: new tables, new columns with a default, new views, new indexes, new codes. It never rewrites rows. A change that needs different rows gets a new table and a view that joins old and new.

**Codes.** Lists that will grow as real rows arrive (the friction facts, the debrief's kinds and endings) are in `ledger/codes.json` rather than in a `CHECK`, so adding one is a merge, not a migration. Writers refuse a code that is not listed. Codes are never renamed or reused. Short, fixed lists (a step's kind, a score, a link's relation) are `CHECK`s in the schema.

## The append-only rule

1. Every table has a pair of triggers that refuse `UPDATE` and `DELETE`, and every connection turns on `recursive_triggers` so `INSERT OR REPLACE` is refused too. `tests/test_ledger_schema.py` fails if a table lacks them or a replace gets through.
2. A fact that changes over time is a new row, not an edit. A resumed session gets a new episode. A session whose ticket moved epic gets a new home. A re-priced session gets a new cost batch. Views named `current_*` show the newest row.
3. **A wrong row is withdrawn, not edited.** A row in `corrections` names the table and row, a reason (`wrong`, `duplicate`, `test-row` or `patient-data`) and, if there is one, the row that replaces it. Every view leaves withdrawn rows out, including a row that would otherwise hide another: withdrawing a wrong replacement, overrule, answer, stage change or branch mark brings back the row it had hidden (found by the audit of PR #18). `ledger/correct.py` writes corrections; Josh or a script may use it, and each row says which.
4. **One exception: patient data.** If patient data ever reaches a text column, withdrawing the row is not enough, because the text would still be in the file. `ledger/redact.py`, which only Josh runs, overwrites that one column of that one row with `withheld: patient data`, inside one transaction that drops and restores that table's update trigger, and adds a `redactions` row saying which table, row and column (never what was there). It then rewrites the backups that hold the row. This is a permanent change, so it is Josh's to run.
5. A decision that stops applying is not a correction. Josh's overrule, a newer answer that supersedes it, and its promotion to a written rule are events, recorded in `decision_events`; the decision row stays as it was, so the history of what was decided is kept.

## Identity: machines, sessions and runs

- **Machine.** `machines.machine_id` is eight random hex digits plus a prefix, `m-1a2b3c4d`, made once when the database is created and also written to `~/.josh-360/state/machine-id`. `label` is a plain name such as "work laptop".
- **Session.** One row per session, written once. `session_uid` is `<machine_id>:<tool>:<tool session id>`; for Claude Code the tool session id is the transcript's file name. Subagents, resumes into a new id and forks are sessions of their own, tied together by `session_lineage` (carried over from Atlas's lineage and the cost ledger's session tree). OpenCode, Pi and Codex sessions use the same table with their own `tool`.
- **Episode.** A session can be resumed after it goes quiet. Each stretch of activity that ends with the session going quiet is an episode, numbered from 1. Everything recorded "when the session goes quiet" belongs to an episode, so a resume adds rows and never touches the old ones.
- **Gone quiet.** A session has gone quiet when its `SessionEnd` hook fired, or when its transcript has not grown for 30 minutes. JP-107 owns this rule and JP-108 uses it.
- **Graph run.** `run_id` is a random id the walker makes. A run names its graph, the graph file's version (`graph_version`, the last commit that changed `graphs/flows/<graph>.yaml`, as JP-140 set) and josh-360's commit when the run started (`repo_commit`), which also covers the roles, agents and gate scripts the run used. That second field answers JP-140's open question without a choice: a comparison can use either.
- **Step.** Each start of a step is a `step_runs` row; `attempt` counts the starts of that step in the run, which is what the run cap counts (JP-139). Each end is a `step_results` row.
- **Ticket.** A ticket is never stored, only its tracker (`jira` or `linear`) and key.

## The tables

The draft schema, `ledger/schema.sql`, is the precise version; this section says what each table is for. Every table also has `id` and `recorded_by` (the script that wrote it), and times are UTC.

### Sessions

| Table | One row per | Key fields |
| --- | --- | --- |
| `sessions` | Session, written the first time it is seen | `session_uid`, `machine_id`, `tool`, `tool_session_id`, `started_at`, `started_by` (josh, daemon, walker, desk, agent-manager, background, josh-360, unknown), `entrypoint`, `start_folder`, `transcript_path` |
| `session_lineage` | Tie between two sessions | `child_uid`, `parent_uid`, `root_uid`, `kind` (subagent, resume, fork, spawned), `confidence` |
| `session_episodes` | Stretch of activity that ended quiet | `episode`, `began_at`, `last_activity_at`, `quiet_at`, `end_reason`, `folder`, `git_root`, `repo`, `branch`, `worktree_path`, `title` (120 characters at most) and its source, `turns` |
| `session_refs` | Thing a session touched | `kind` (folder, branch, commit, pr, worktree, file), `repo`, `value` (a path, name, sha or URL), `source` |

### Homes and links

| Table | One row per | Key fields |
| --- | --- | --- |
| `ticket_links` | Tie between a session or a run and a ticket | `tracker`, `ticket_key`, `relation` (touched, subject, created, duplicate-of), `source` (branch, jira-command, daemon, walker, offer, josh, backfill) |
| `session_homes` | Answer to "where does this session belong", each time it changes | `method` (branch, ticket-link, registry, unassigned), `ticket_key`, `epic_key`, `initiative_key`, `area`, `system`, `priority`, `evidence`, `conventions_version`, `jira_read` |

### Cost and summaries

| Table | One row per | Key fields |
| --- | --- | --- |
| `session_costs` | Session and model, per pricing | `computed_at`, `model`, five token counts, `cost_usd`, `pricing_status`, `price_set` |
| `model_calls` | Model call Josh 360 itself makes (summary, debrief, weekly review) | `purpose`, `subject_session_uid`, `model`, tokens, `cost_usd` |
| `session_summaries` | Episode | `lines` (five lines and 800 characters at most), `method` (copied or model), `model_call_id`, `lines_withheld` |
| `session_state_notes` | U-turn, dead end or untold finding copied from STATE.md | `kind`, `note` (300 characters at most) |

### Friction

| Table | One row per | Key fields |
| --- | --- | --- |
| `session_facts` | Count per episode (JP-112) | `fact` (a code from `codes.json`), `value` |
| `session_usage` | Skill, agent, tool, MCP server, hook or rule file per episode | `item_kind`, `item_name`, `loaded`, `uses` |
| `debriefs` | Debriefed episode (JP-113) | `model_call_id`, `form_version`, `ended_how` (a code) |
| `debrief_moments` | Moment in a debrief, five at most | `kind` (a code), `target_kind`, `target_name`, `pointer` (a transcript entry id, never its text) |

### Graph runs

| Table | One row per | Key fields |
| --- | --- | --- |
| `graph_runs` | Run | `run_id`, `graph_id`, `graph_source` (graph-file or external), `graph_version`, `repo_commit`, `subject_kind` (ticket, intake, pr) and `subject_ref`, `ticket_key`, `previous_run_id`, `phi`, `runner` |
| `step_runs` | Start of a step | `step_id`, `step_kind`, `attempt`, `loop_count`, `tier`, `role`, `agent`, `allowed_by_josh`, `session_uid` |
| `step_results` | End of a step | `outcome`, `model` (the one that actually answered), `session_uid`, `note` (a gate's one-line summary, 200 characters at most, empty when the run is `phi`) |
| `run_files` | File a run produced or saved at closeout | `kind` (spec, plan, evidence, feedback, deliverable, output), `path`, `sha256` |
| `run_ends` | Run that ended | `end_name` (`finished`, `<step>.<outcome>` or `exit_refused`), `score` (success, neutral, needs-josh) |
| `comment_deliveries` | Ticket comment passed to a session or run (JP-118) | `comment_id`, `author_account`, `via`; a unique index makes each delivery happen once |

Notes:

- `previous_run_id` points at the latest earlier run on the same ticket, of any graph, so a ticket that came back can be counted ("a run that returned later", JP-140).
- `score` is copied from the `end_states` header of the graph version the run used, so a later change to a score never rewrites old runs (`graphs/CONVENTION.md`, "Scoring a run").
- A step that started and never ended (its session was killed) has no result. The walker ends it as `_abandoned`, a reserved outcome, before it starts the step again; the new start counts as another attempt under the run cap.
- The view `step_ledger` gives exactly the eleven fields a graph header's `ledger` list may name: `run`, `step`, `outcome`, `loop_count`, `session`, `tier`, `ticket`, `started_at`, `ended_at`, `graph_version`, `model`. The view `step_costs` joins each step to its session's cost.
- action-triage's PR audit is not a graph yet. Each audit round is recorded as a run with `graph_source` `external`, `graph_id` `pr-audit`, subject the PR, and one step, `audit`, whose outcome is the verdict label. That makes "fix rounds after review" countable without inventing a task.

### Decisions

| Table | One row per | Key fields |
| --- | --- | --- |
| `asks` | Question put to Josh | `ask_id`, the run, step or session that asked, `category`, `question_key` (`<graph>/<step>`), `system`, `work_type`, `ticket_key`, `question` and `choices` (500 characters each at most), `stage`, `suggested_answer` and `precedent_decision_id`, `channel` (needs-you, jira-flag, thread, terminal) |
| `decisions` | Answer | `ask_id`, the same lookup fields, `answer`, `how` (answered, confirmed-suggestion, changed-suggestion, from-memory, recorded), `decided_by` (josh or memory), `rests_on_decision_id`, `supersedes_decision_id` |
| `decision_events` | Later event on a decision | `kind` (overruled, superseded, promoted-to-rule, miss), `related_decision_id`, `rule_path`, `event_by` |
| `category_stages` | Stage change of a category | `category`, `stage` (1, 2, 3), `set_by` (josh, or demotion when a promoted category is overruled) |
| `memory_lookups` | Precedent lookup | `question_key`, `system`, `work_type`, `found`, `used_decision_id` |

How the vision's four memory rules land:

- *An answer from memory must quote the decision it rests on.* `decisions` refuses `how = from-memory` without `rests_on_decision_id` (a `CHECK`), and the walker's script drops any that do not first.
- *An overruled decision is marked superseded and never used again.* The `current_decisions` view leaves out any decision with an `overruled` or `superseded` event, or a newer decision that supersedes it.
- *A question Josh answers that had a usable precedent is a miss.* A `miss` event on the new decision, pointing at the precedent.
- *An answer given several times becomes a written rule.* A `promoted-to-rule` event with the rule's file in josh-360.

Lookup is exact: same `question_key`, same `system`, same `work_type`. An open question is an ask with no decision (`open_asks`). A run parks on an open ask and resumes when the decision is written, so a parked run survives a closed terminal (JP-114). The `questions/` folder action-triage's Needs you tab uses stays as the way a question reaches Josh and his answer comes back; the ledger is the record of both.

### Josh's marks

| Table | One row per | Key fields |
| --- | --- | --- |
| `ticket_offers` | Offer made, accepted or declined (JP-110) | `event`, `offer_trigger` (first-commit, first-branch), `ticket_key` |
| `branch_marks` | Branch Josh keeps, or stops keeping, on purpose (JP-109) | `git_root`, `branch`, `mark`, `note`; the view `kept_branches` gives the current set |

## How a session finds its home

The recorder works out a home when an episode goes quiet, with no model, in this order. The first step that gives an answer wins. Every answer is written to `session_homes` with the method, the evidence it used and the commit of `conventions/` it read.

1. **Branch name.** The episode's branch starts with a ticket key: `^([A-Z][A-Z0-9]+-[0-9]+)([/-]|$)` (`conventions/tickets.md`, "Branches"), in a space the registry lists or a Linear team key. Method `branch`.
2. **Ticket links.** Otherwise, the session's `ticket_links`: first the ticket of a graph run the session did a step for (`step_runs.session_uid`), then the newest link from the daemon, an accepted ticket offer, or Josh. A Jira command counts only when it moved or commented on the ticket, the rule the cost ledger's Jira hook already follows (`claude-360/src/costledger/jira-hook.ts`), so a session that only read a ticket is not homed under it. Method `ticket-link`.
3. **The registry.** Otherwise, `scripts/conventions.py lookup --folder <folder>` on the episode's folder, then `--repo <repo>`. The system's registry row gives its area and priority. Method `registry`.
4. **Unassigned.** Otherwise the home is `unassigned`, and nobody is asked.

For methods 1 and 2, the recorder reads the ticket from Jira to get its epic, the initiative the epic relates to, and its system (its Repository field, else its system label). The priority then comes from `conventions.py priority`: the epic, then the initiative, then the system's area, else `unassigned`. If the Jira read fails, the home is written with the ticket and `jira_read = failed`, and the next pass tries again. A Linear key's home has `tracker = linear` and priority `unassigned` until JP-132 designs personal homes.

As queries, with the registry and priorities read from their JSON copies (see the plan, Task 4):

```sql
-- 1. Branch: the newest episode's branch, matched in the recorder (Python re), never by a model.
SELECT branch FROM session_episodes WHERE session_uid = :uid ORDER BY episode DESC LIMIT 1;

-- 2. Ticket links: a run's ticket first, then the newest link from a trusted source.
SELECT g.tracker, g.ticket_key FROM step_runs s JOIN graph_runs g ON g.run_id = s.run_id
WHERE s.session_uid = :uid AND g.ticket_key IS NOT NULL ORDER BY s.started_at DESC LIMIT 1;
SELECT tracker, ticket_key FROM ticket_links
WHERE session_uid = :uid AND relation = 'touched' AND source IN ('daemon', 'walker', 'offer', 'josh', 'jira-command', 'backfill')
  AND NOT EXISTS (SELECT 1 FROM corrections c WHERE c.table_name = 'ticket_links' AND c.row_id = ticket_links.id)
ORDER BY linked_at DESC LIMIT 1;

-- 3 and 4 are lookups in conventions/registry.json and conventions/priorities.json.
```

A home is worked out again, and a new row added only if the answer changed, when the session is resumed and goes quiet again, and once a night for sessions active in the last 30 days (a ticket can move epic, and the registry can change). The dashboard and every query read `current_homes`.

## Where each overlap lands

The vision's "Overlaps found while reading the code", each with the one table that now holds it.

| Overlap today | The one table | What happens to the rest |
| --- | --- | --- |
| Three stores answer "what is this session doing": the `/focus` file, Session Atlas's focus summary, STATE.md | `session_summaries` (once the session goes quiet). While it runs, STATE.md is the live record and is not in the ledger. | The `/focus` file retires (JP-100); the focus summary retires (S3, JP-111). U-turns and dead ends from STATE.md are copied into `session_state_notes` before its 30-day clean-up. |
| About seven ideas of a task: action item, to-do, GitHub issue, Jira ticket, Linear ticket, task-manager task, focus subtask | `ticket_links`. The ticket itself stays in Jira or Linear. | Action items, to-dos and forwarded emails are intake: they stay in their own stores and appear in the ledger only as the subject of a ticket-creation run (`graph_runs.subject_kind = intake`). GitHub issues, task-manager tasks and focus subtasks retire (A10, JP-96 question 4, S3). |
| Two ideas of a session: Session Atlas's record and action-triage's agent session record | `sessions` | The daemon's records become graph runs and steps that point at a session (`step_runs.session_uid`). Its retry flags stay in its own state file, because they are a running program's to-do list, not facts. |
| Four memory mechanisms besides Jira: Session Atlas, claude-mem, the Obsidian staging hook, context-mode | `sessions` with `session_summaries` for what happened, `decisions` for what Josh decided | claude-mem, the staging hook and context-mode are dismantled (JP-96). Transcripts are pointed at (`sessions.transcript_path`), never copied. |
| Roughly twenty background jobs | None: jobs are not data. `jobs.yaml` and the macbook-automations startup list hold them (JP-119). | Not a data model question. |
| A Session Atlas database over 5 GB | `ledger.db` stays small (about 60 MB a year); the bulk moves to `cache.db` with a retention rule | See [Expected size and retention](#expected-size-and-retention). |

And the overlaps the feature list (JP-97) found between the two apps:

| Overlap | The one table |
| --- | --- |
| Session titles: Atlas's title choice and the cost ledger's `session_labels` | `session_episodes.title` and `title_source`, using Atlas's order (custom title first) |
| Session to ticket: Atlas's Jira links, the daemon's `__tickets__` records, the desk's ticket column | `ticket_links` |
| Files a session made: action-triage's archive, Atlas's two file lists | `session_refs` of kind `file` (the fact); the file catalog itself is in `cache.db` |
| Where Josh is asked: Needs you, issue comments, Atlas's Needs attention | `asks` (Needs attention stays as system health, not a question) |
| Who reviews a PR | `graph_runs` with `graph_id = pr-audit` |
| What starts a session for a ticket | `graph_runs.runner` and `step_runs.session_uid` |

## What moves in from today's stores

Every store the inventories found that holds session, run or decision data, and where it goes. "Stays" means it stays in its own app as working state; "left behind" means nothing moves and the store is retired with its feature.

### Session Atlas: `~/.claude/atlas/atlas.db`

| Table | Goes to |
| --- | --- |
| `sessions` | `sessions` and `session_episodes` (see [the ticket's questions](#the-tickets-four-questions-answered) for the field list) |
| `session_lineage` | `session_lineage` |
| `transcript_checkpoints`, `events_seen`, `worker_jobs` (non-focus jobs), `title_scan_jobs`, `transcript_replay_jobs`, `attention_acks`, `atlas_maintenance`, `backup_manifest` | `cache.db` (working state) |
| `artifact_repositories`, `artifact_roots`, `artifact_documents`, `artifact_versions`, `artifact_version_state`, `artifact_evidence`, `artifact_jobs`, `artifact_document_aliases`, `artifact_manager_state`, `artifact_identity_adoptions` | `cache.db`; JP-111 confirms the catalog can be rebuilt from a rescan. The fact that a session made a file is `session_refs`. |
| `focus_states`, focus jobs in `worker_jobs` | Left behind (S3 retires) |
| `artifacts`, `artifact_origins`, `artifact_candidates` | Left behind once the artifact manager has adopted them (S14) |
| `session_cost_cache`, `session_cost_cache_state` | Left behind; the `current_session_costs` view replaces it |
| `session_usage`, `model_pricing`, the `usage_*` tables, `session_usage_summary`, `source_anomalies` | Left behind (already retired by Atlas's migration 8) |
| `sessions_fts` | Left behind; JP-111 may rebuild a title search in `cache.db` from ledger titles |

### Cost ledger: `~/.claude/cost-ledger/ledger.db`

| Table | Goes to |
| --- | --- |
| `messages`, `models`, `model_aliases`, `prices`, `pricing_runs`, `message_costs`, `import_runs`, `source_files`, `repos`, `label_scans`, `message_holders`, `claude_spawn_owners`, `session_links` | `cache.db`, unchanged |
| `session_nodes` | `cache.db`, unchanged, and copied into `session_lineage` |
| `session_labels` | `session_episodes.title` and `title_source` (`custom_title` to custom, `ai_title` to ai, `agent_name` to agent-name, `tool_title` to tool) |
| `session_pr_links` | `session_refs` of kind `pr` |
| `jira_session_links` | `ticket_links`, relation `touched`, source `jira-command` (`backfill` for the rows already there) |

### action-triage

| Store | Goes to |
| --- | --- |
| Daemon `state.json`, `__tickets__` records | History: a graph run per pickup once the daemon asks the walker for the next step (JP-97 question 3), with `ticket_links` source `daemon` until then. Retry flags, claims and pending writes stay in `state.json`. |
| Daemon `state.json`, PR-audit records | History: one `pr-audit` run per audit round (see [Graph runs](#graph-runs)). Recovery and finalisation flags stay in `state.json`. |
| Daemon `state.json`, GitHub issue records, `__startAttempts__` | Left behind (A10 retires); the start-attempt tally stays as working state |
| `questions/` | Stays as the channel to the Needs you tab; each question and answer is also an `asks` and a `decisions` row |
| `outbox/`, `mailbox/` | Stay as the session's channel to Jira; what they relay ends up as Jira comments, not ledger rows. A delivered comment is a `comment_deliveries` row. |
| `review-priority.json` | Stays (Josh's order for the audit queue, a setting) |
| `session-files/` | Left behind with A24's merge into the artifact manager |
| `activity.json` | Left behind; the Activity tab reads ledger runs and steps (A25) |
| App `state.json`, `action-items.json`, `notion-data.json`, `desk.db` | Stay in their apps as intake and working state. The desk's research runs become graph runs once the non-development graph does that work (JP-104). |

### Elsewhere on the laptop

| Store | Goes to |
| --- | --- |
| STATE.md (`~/.claude/session-state/`) | Stays the live record; its U-turns, dead ends and untold findings are copied into `session_state_notes`, and its compaction count into `session_facts` |
| `/focus` files, compaction summaries, handoff files | Left behind (JP-100) |
| claude-mem, Obsidian staging, context-mode, agentmemory | Left behind (dismantled, JP-96) |
| `docs/decisions.md` | Josh's answers from the question rounds are loaded as `recorded` decisions by JP-116; agents' default choices stay in the file, which remains the record of build-time choices |
| Jira and Linear tickets | Stay in their trackers; the ledger holds keys |

## Who writes what

Hooks and scripts write the facts, never a working agent (vision guardrail 1). Hooks stay fast: they append one line to a spool file and never open the database. Scripts write the database.

| Tables | Written by | Ticket |
| --- | --- | --- |
| `machines`, `schema_migrations` | The install step | JP-107 |
| `sessions`, `session_lineage`, `session_episodes`, `session_refs`, `session_homes`, `session_costs`, `session_state_notes`, `ticket_links` (branch, jira-command, backfill) | The recorder job, from the hook spool, the transcript, git and the cost import | JP-107 |
| `session_summaries`, `model_calls` | The summary script | JP-108 |
| `branch_marks` | `ledger/ask.py keep`, which Josh runs | JP-109 |
| `ticket_offers`, `ticket_links` (offer) | The offer hook, through the spool | JP-110 |
| `session_facts`, `session_usage` | The friction script | JP-112 |
| `debriefs`, `debrief_moments` | The debrief script, sharing the summary's call | JP-113 |
| `graph_runs`, `step_runs`, `step_results`, `run_files`, `run_ends`, `asks`, `ticket_links` (walker) | The walker | JP-114 |
| `decisions`, `decision_events`, `category_stages`, `memory_lookups` | The decision command (stage changes only from Josh's own command) | JP-116 |
| `comment_deliveries` | The comment relay | JP-118 |
| `graph_runs` for `pr-audit`, `ticket_links` (daemon) | action-triage's daemon, once it moves onto the ledger | JP-124 |
| `corrections` | `ledger/correct.py` | JP-107 |
| `redactions` | `ledger/redact.py`, Josh only | JP-107 |

## Patient data

No patient data in the ledger (vision, Standing rules). The design keeps it out in three layers.

1. **No column for it.** No column holds transcript text, message text, command output or file contents. Files are paths, transcript moments are entry ids, comments are ids, and friction is counts and codes. The test fails if a column is named for any of these.
2. **Short text only, capped.** Twelve columns hold free text, and each has a length cap in the schema: a session's title (120 characters), its summary (five lines, 800 characters), a STATE.md note (300), a gate's one-line note (200), an ask's question, choices and suggested answer and a decision's answer (500 each), a stage change's reason and a branch mark's note (200), a home's evidence (300) and a machine's label (60). The test lists exactly these and fails if another free-text column appears or one loses its cap.
3. **Checked before it is written.** Every writer passes those columns through one patient-data check, `graphs/gates/lib/patient_data.py` (the helper JP-102's plan names; whichever ticket lands first creates it). A line that fails is not stored: a summary line becomes `withheld: patient data` and is counted in `lines_withheld`. A run marked `phi` stores no question, note or answer text at all, only codes and paths. A session whose folder is inside a `.phi` folder stores no title, summary or notes.

The summary is the one place a session's own words could reach the ledger, because the vision builds it from the title, the first message and STATE.md. JP-99's acceptance criteria say no field stores message text. This design follows the criteria: no line is copied from a message; the one small model call, made only when the title and STATE.md are too thin, writes the "what was asked" line in its own words and passes the same check. This is [question 2](#questions-for-josh).

If patient data is found in the ledger anyway, Josh runs `ledger/redact.py` ([The append-only rule](#the-append-only-rule), rule 4).

## Loose ends are computed, never stored

There is no table of loose ends, and the test fails if one appears. The ledger only remembers which session touched which folder, branch, commit, worktree and pull request (`session_refs`), and which ticket (`current_homes`, `ticket_links`). When Josh asks, JP-109's script reads git and the trackers as they are at that moment:

| Josh's loose end | Ledger input | Checked live against |
| --- | --- | --- |
| A session with commits but no branch or pull request | `session_refs` of kind `commit` | `git branch --contains`, then GitHub |
| A local branch with no remote branch | `session_refs` of kind `branch` and `folder` | `git for-each-ref` |
| A linked ticket that is not Done | `current_homes`, `ticket_links` | Jira or Linear |
| An open pull request | `session_refs` of kind `pr` | GitHub |
| A leftover worktree | `session_refs` of kind `worktree` | `git worktree list` |
| An orphaned branch not kept on purpose | `session_refs` of kind `branch`, minus `kept_branches` | git |

A day when Josh skips the system loses nothing, because nothing was owed.

## Queries agents may call

Memory is pull only, and answers are small. Working agents get one command, `ledger/ask.py`, with six named queries and nothing else: no SQL, no file path. Each answer is at most 20 rows and 4 KB of JSON, and none returns friction facts, usage, debriefs, costs or measures (JP-112: working agents never see the measures).

| Query | Arguments | Returns |
| --- | --- | --- |
| `home` | `--session <id>` | The session's current home: ticket, epic, system, method. Never the priority (working agents never see priorities). |
| `ticket` | `--key <KEY>` | The sessions and runs on a ticket: ids, dates, titles, first summary line, graph and how each run ended |
| `find` | `--folder <path>` or `--branch <name>`, `--since <date>` | Recent sessions there, with title and summary, so a session with no ticket can be found and picked up again |
| `precedent` | `--question-key <graph/step> --system <name> --work-type <kind>` | Up to three current decisions with their ids, answers, dates and tickets. Every call adds a `memory_lookups` row. |
| `run` | `--run <id>` | A run's steps so far with outcomes and attempts (what the walker reads to say the next step) |
| `changes` | `--system <name>` or `--repo <owner/name>`, `--since <date>` | The changelog answer, below |

Josh and Josh 360's own scripts (the walker, the measures, the weekly review, later the dashboard) read the database directly. The database file is not a security boundary: a session on the laptop runs as Josh's user and could open it. The guard is that working agents are given only `ask.py`, and that nothing in a ledger row is secret.

## The query that replaces a changelog file

Per-project changelog files cause merge conflicts across branches, and status lives in Jira (`docs/WORKFLOW.md` §1.7). The ledger already knows which sessions in a system committed or opened a pull request, so the changelog is a query:

```sql
SELECT e.quiet_at, h.ticket_key, h.system, s.session_uid,
       (SELECT r.value FROM session_refs r WHERE r.session_uid = s.session_uid AND r.kind = 'pr'
        ORDER BY r.observed_at DESC LIMIT 1) AS pull_request,
       (SELECT substr(m.lines, 1, instr(m.lines || char(10), char(10)) - 1) FROM session_summaries m
        WHERE m.session_uid = s.session_uid ORDER BY m.episode DESC LIMIT 1) AS summary_line
FROM sessions s
JOIN current_homes h ON h.session_uid = s.session_uid
JOIN session_episodes e ON e.session_uid = s.session_uid
     AND e.episode = (SELECT MAX(episode) FROM session_episodes WHERE session_uid = s.session_uid)
WHERE h.system = :system AND e.quiet_at >= :since
  AND EXISTS (SELECT 1 FROM session_refs r WHERE r.session_uid = s.session_uid AND r.kind IN ('commit', 'pr'))
ORDER BY e.quiet_at DESC LIMIT 20;
```

Whether a pull request merged or a ticket is Done is not in this answer: what an agent says about its own work is a claim, so "done" is read from GitHub and Jira when shown (`--live` adds those reads).

## What the measures read

The measures are built as stored queries by JP-112 and shown by the phase 3 dashboard (JP-130). This design only makes sure every one of them has its rows. None needs a model.

| Measure (vision) | Reads |
| --- | --- |
| Josh's messages per finished ticket | `session_facts` (`josh_messages_*`), `current_homes`, ticket status read live |
| Times a ticket waited on Josh, and how long | `asks` and `decisions` (asked and decided times), `session_facts` (`seconds_waiting_on_josh`) |
| Share signed off without being sent back; tickets the sign-off agent sent back; fix rounds after review | `run_ends`, `step_results`, `graph_runs.previous_run_id`, `pr-audit` runs |
| Number and age of loose ends | Computed (JP-109) |
| Share answered from precedent; suggestions accepted against overruled; lookups that found nothing | `decisions.how`, `decision_events`, `memory_lookups` |
| Spend and time per ticket, by step | `step_costs`, `current_session_costs`, `step_ledger` times |
| Size of the instructions a session loads; skills and rules nobody used | `session_facts` (`instruction_bytes_loaded`), `session_usage` |
| Graph effectiveness and efficiency per graph and version (JP-140) | `run_ends.score` by `graph_runs.graph_id` and `graph_version`, `step_costs` |
| Run-cap use (JP-139) | `step_runs.attempt`, `tier`, `allowed_by_josh` |

## Expected size and retention

**Size of `ledger.db`.** About 100 sessions a week (102.6 over the seven weeks with full records, `docs/inventory/starting-figures.md`), so about 5,300 a year. One session episode is about 70 rows (25 refs, mostly files; 14 facts; 20 usage rows; a few homes, costs and notes; a summary), about 10 KB with indexes: about 55 MB a year. Graph runs add about 5 MB a year at 20 runs a week of 12 steps. Decisions are a few thousand rows. **About 60 MB a year.**

**Retention.** `ledger.db` is kept for ever. At this size that is 15 years before it reaches 1 GB, and the weekly review needs history. When it passes 1 GB, a ticket proposes what to roll up. Backups: 14 daily and 8 weekly compressed copies, about 0.5 GB after a year.

`cache.db` keeps the cost import's per-message rows for 90 days after their session's cost has been copied into `session_costs`; older rows are removed, because the ledger then holds the per-session figure. Today's cost ledger is 635 MB and Atlas's database 621 MB, so `cache.db` should settle near 0.5 GB. Removing those rows is a permanent deletion of data that can no longer be rebuilt once the transcripts are gone, so it is part of [question 3](#questions-for-josh).

Transcripts are pointed at, not kept. When Claude Code's own clean-up removes a transcript, `sessions.transcript_path` points at nothing; every fact already copied stays.

## Rules

1. One ledger per machine, `~/.josh-360/state/ledger.db`, SQLite, standard library only.
2. Every table is append-only, enforced by triggers. A wrong row is withdrawn with a `corrections` row. The only overwrite is Josh's patient-data redaction.
3. Every session, run and machine has a text key that is unique across machines.
4. Hooks write spool lines; scripts write the database; working agents never write it.
5. No column holds transcript text, message text, command output or file contents. Free text lives only in the twelve capped columns, after the patient-data check.
6. No table of loose ends. They are computed when asked.
7. Tickets stay in their trackers; the ledger stores tracker and key.
8. A session's home is worked out with no model, in the order branch, ticket links, registry, Unassigned, and each answer records its method and evidence.
9. Working agents read only through `ledger/ask.py`'s six queries, which return at most 20 rows and never friction, cost, measures or priorities.
10. A run's score is copied from its graph version's header when it ends.
11. A decision answered from memory names the decision it rests on, or it is refused.
12. Only Josh's own command raises a category's stage.
13. A schema change is a numbered migration that only adds, applied by the install script after a backup.
14. The ledger is backed up daily and kept for ever.

## Acceptance criteria

Copied from the ticket.

```gherkin
Feature: One data model

  Scenario: Every overlap is settled
    Given the overlaps listed under "What exists today" in the vision document
    When the design is read
    Then each overlap names the one table that holds it

  Scenario: Patient data has no home
    Given the schema
    Then no field stores transcript text, message text or file contents
    And a summary is limited to about five lines

  Scenario: Loose ends are not stored
    Given the schema
    Then it has no table of loose ends
    And the design says they are computed from git and tickets when asked
```

| Scenario | Proof |
| --- | --- |
| Every overlap is settled | [Where each overlap lands](#where-each-overlap-lands): one row per overlap in the vision, each naming one table (`@manual`, Josh reads it at JP-106) |
| Patient data has no home | `tests/test_ledger_schema.py`, `PatientDataHasNoHome` (no column named for transcript, message or file text; every free-text column capped; a sixth summary line refused) (`@auto`) |
| Loose ends are not stored | `tests/test_ledger_schema.py`, `LooseEndsAreNotStored`, and [Loose ends are computed, never stored](#loose-ends-are-computed-never-stored) (`@auto`) |

The test file also checks that the schema loads into an empty database, that every table refuses edits and deletes, that a resumed session adds rows, that a correction withdraws a home, that the step view carries the convention's eleven fields, that `exit_refused` always scores needs-josh, and that an answer from memory must rest on a decision.

## Out of scope

- Building the ledger, the recorder or any writer (JP-107 and the tickets in [Who writes what](#who-writes-what)).
- Dashboard queries and how measures are shown (phase 3, JP-130).
- A cloud database, and merging two machines' ledgers (phase 3).
- The final lists of friction facts and debrief kinds, settled from two weeks of real rows (JP-112, JP-113); `ledger/codes.json` holds the starting lists.
- The layout of `cache.db` beyond which existing tables go there (JP-111).

## Choices made

Choices that can be undone, taken on the recommended option and recorded in `docs/decisions.md`.

| Question | Option taken | How to undo |
| --- | --- | --- |
| Where does the design live: the ticket's `docs/design/data-model.md` or `docs/superpowers/specs/`? | The ticket's path, as JP-104 did; the plan is in `docs/superpowers/plans/`. | Move the file and update the plan's link. |
| What is "gone quiet"? | `SessionEnd`, or 30 minutes with no new transcript entry. JP-107 owns it, JP-108 reuses it. | Change the rule in the recorder. |
| Do hooks write the database? | No. They append a spool line; a job writes the database every five minutes. A hook stays fast and a locked database never slows a session. | Let the `SessionEnd` hook write directly. |
| Is the PR audit a graph run? | Yes, an `external` run with one step per round, until it becomes a graph. | Give audits their own table. |
| Does a Jira command that only reads a ticket home a session under it? | No; only a transition or a comment, the cost ledger hook's own rule. | Count every Jira command in rule 2. |
| Which version does a run record? | Both the graph file's commit (`graph_version`, JP-140) and josh-360's commit (`repo_commit`), which answers JP-140's open question about parts without a choice. | Drop `repo_commit`. |
| Where do the growing code lists live? | `ledger/codes.json`, not `CHECK`s. | Move them into `CHECK`s with a migration each. |

## Questions for Josh

For the phase 1 question sitting (JP-106). Each has a recommendation; JP-107 can start on the recommended options and change course cheaply until it merges.

1. **One file or two?** *Recommendation: two.* `ledger.db` holds the facts, append-only, small, backed up daily and kept for ever. `cache.db` holds the large working tables that can be rebuilt: the cost import's per-message rows and the file catalog. *Other route:* one file for everything, which makes backups ten times larger and needs an exception to the append-only rule for the cost import's re-pricing.
2. **May the ledger hold any of Josh's own words?** The vision builds the summary from the title, the first message and STATE.md; the ticket's acceptance criteria say no field stores message text. *Recommendation: follow the criteria.* No line is copied from a message; the summary comes from the title and STATE.md, and the one small model call, made only when those are too thin, writes the "what was asked" line in its own words. Every short text passes the patient-data check and has a length cap. *Other route:* copy the first line of the first message (160 characters at most) after the same check, which describes question-only sessions better with no model call.
3. **Backups and retention.** *Recommendation:* keep `ledger.db` for ever; 14 daily and 8 weekly compressed backups, on the laptop only; remove the cost import's per-message rows from `cache.db` 90 days after each session's cost is copied into the ledger. *Other routes:* also copy backups off the laptop (OneDrive), which the vision defers to "moving data off the laptop"; or keep the per-message rows for ever (about 0.6 GB now, growing).
4. **What is a "category" of question for the three stages?** *Recommendation: one category per asking step,* `<graph>/<step>` (for example `triage/ask_josh`), so Josh promotes "the triage questions" as one; lookup still needs the same system and type of work. *Other route:* one category per step and system, so Josh can promote a question for one system before another, at the cost of many more categories to manage.
