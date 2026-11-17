-- Josh 360 ledger: draft schema (JP-99). Design: docs/design/data-model.md.
--
-- DRAFT. JP-107 creates the database from this file after Josh's JP-106 sitting. Nothing reads or writes it yet.
-- Amended by JP-148 (the JP-146 review's fixes A1 to A5) before the database first exists.
--
-- This is ledger.db, the one append-only record of facts on one machine. The large, rebuildable working tables
-- (the message-level cost import, prices, scan marks, the artifact catalog) live in a second file, cache.db,
-- which is not described here (design, "Storage").
--
-- Rules every table follows (design, "The append-only rule"):
--   * Rows are only ever inserted. Every table has two triggers that refuse UPDATE and DELETE.
--   * A wrong row is retracted by a row in `corrections`, never edited. A correction can itself be withdrawn,
--     which brings the row back; `live_corrections` holds the corrections still in force, and every view reads it.
--     Views named current_* leave retracted rows out and, where a newer row replaces an older one, keep only the
--     newest.
--   * Five tables hold one row per natural key (an episode, its summary and debrief, a step's result, a run's end).
--     They carry a `version`: a withdrawn row is replaced by the next version, which a trigger allows only once the
--     version before it is withdrawn (JP-148, review finding A3).
--   * Times are UTC text, ISO 8601 with a trailing Z (2026-11-16T22:09:38Z).
--   * recorded_by names the script that wrote the row (recorder, walker, summary, decision-cli, ...).
--   * No column holds transcript text, message text or file contents. The few short text columns are capped
--     by a CHECK and their writers run them through the patient-data check first (design, "Patient data").
--   * There is no table of loose ends. They are computed from git and the tickets when asked.
--
-- SQLite 3.31 or later (the laptop's /usr/bin/python3 3.9 standard library). No STRICT tables, no RETURNING.
-- Open every connection with PRAGMA foreign_keys = ON and PRAGMA recursive_triggers = ON. Without the
-- second, INSERT OR REPLACE deletes the old row without firing its no_delete trigger.

PRAGMA user_version = 1;

-- ---------------------------------------------------------------------------------------------------------------
-- Bookkeeping
-- ---------------------------------------------------------------------------------------------------------------

CREATE TABLE schema_migrations (
  id          INTEGER PRIMARY KEY,
  version     INTEGER NOT NULL UNIQUE CHECK (version >= 1),
  name        TEXT    NOT NULL,
  applied_at  TEXT    NOT NULL
);
INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, 'draft schema (JP-99, amended by JP-148)', '2026-11-16T00:00:00Z');

-- One row for the machine this ledger lives on, written when the ledger is created. A ledger merged in from another
-- machine later brings its own row. Every session and run names its machine, so two ledgers never clash.
CREATE TABLE machines (
  id           INTEGER PRIMARY KEY,
  machine_id   TEXT NOT NULL UNIQUE CHECK (length(machine_id) BETWEEN 8 AND 40),
  label        TEXT NOT NULL CHECK (length(label) <= 60),      -- "work laptop"; never a person's name
  created_at   TEXT NOT NULL,
  recorded_by  TEXT NOT NULL
);

-- A wrong row is retracted here. replacement_row_id points at the row that replaces it, in the same table, if one
-- already exists; in the five versioned tables the replacement is simply the next version, written after this row.
-- A correction can be withdrawn by a correction naming table 'corrections', which brings its row back; that second
-- correction cannot itself be withdrawn, and a row is withdrawn again with a new correction. A row has at most one
-- correction in force at a time (triggers below).
CREATE TABLE corrections (
  id                  INTEGER PRIMARY KEY,
  table_name          TEXT    NOT NULL,
  row_id              INTEGER NOT NULL,
  reason              TEXT    NOT NULL CHECK (reason IN ('wrong', 'duplicate', 'test-row', 'patient-data')),
  replacement_row_id  INTEGER,
  corrected_at        TEXT    NOT NULL,
  corrected_by        TEXT    NOT NULL CHECK (corrected_by IN ('josh', 'script')),
  recorded_by         TEXT    NOT NULL
);

-- The one exception to the append-only rule: patient data found in a text column is overwritten in place by
-- `ledger redact`, which Josh runs. This table records that it happened (never what was there).
CREATE TABLE redactions (
  id           INTEGER PRIMARY KEY,
  table_name   TEXT    NOT NULL,
  row_id       INTEGER NOT NULL,
  column_name  TEXT    NOT NULL,
  redacted_at  TEXT    NOT NULL,
  redacted_by  TEXT    NOT NULL CHECK (redacted_by = 'josh'),
  recorded_by  TEXT    NOT NULL
);

-- ---------------------------------------------------------------------------------------------------------------
-- Sessions
-- ---------------------------------------------------------------------------------------------------------------

-- One row per session, written once, when the session starts (JP-148, review finding A1): the recorder writes it from
-- the SessionStart spool line on its next pass, and the walker, the recorder and the backfill add it with
-- `ledger.sessions.ensure` whenever they meet a session that has no row yet. Six tables point at it while the session
-- is still running (step runs, step results, asks, ticket links, comment deliveries, model calls), so it cannot wait
-- for the session to go quiet. session_uid is "<machine_id>:<tool>:<tool_session_id>". A subagent is a session of
-- its own, tied to its parent by session_lineage.
CREATE TABLE sessions (
  id               INTEGER PRIMARY KEY,
  session_uid      TEXT NOT NULL UNIQUE,
  machine_id       TEXT NOT NULL REFERENCES machines (machine_id),
  tool             TEXT NOT NULL CHECK (tool IN ('claude-code', 'opencode', 'pi', 'codex', 'other')),
  tool_session_id  TEXT NOT NULL,
  started_at       TEXT NOT NULL,
  started_by       TEXT NOT NULL CHECK (started_by IN ('josh', 'daemon', 'walker', 'desk', 'agent-manager',
                                                       'background', 'josh-360', 'unknown')),
  entrypoint       TEXT CHECK (entrypoint IS NULL OR length(entrypoint) <= 40),   -- cli, sdk-cli, ...
  start_folder     TEXT,                                                          -- a path
  transcript_path  TEXT,                                                          -- a pointer, never a copy
  recorded_at      TEXT NOT NULL,
  recorded_by      TEXT NOT NULL,
  UNIQUE (machine_id, tool, tool_session_id),
  CHECK (session_uid = machine_id || ':' || tool || ':' || tool_session_id)
);

-- Subagents, resumes and forks, carried over from Session Atlas's session_lineage and the cost ledger's session tree.
CREATE TABLE session_lineage (
  id            INTEGER PRIMARY KEY,
  child_uid     TEXT NOT NULL REFERENCES sessions (session_uid),
  parent_uid    TEXT NOT NULL REFERENCES sessions (session_uid),
  root_uid      TEXT NOT NULL REFERENCES sessions (session_uid),
  kind          TEXT NOT NULL CHECK (kind IN ('subagent', 'resume', 'fork', 'spawned')),
  confidence    TEXT NOT NULL CHECK (confidence IN ('confirmed', 'inferred')),
  discovered_at TEXT NOT NULL,
  recorded_by   TEXT NOT NULL,
  CHECK (child_uid <> parent_uid)
);

-- One row each time a session goes quiet. A resumed session that goes quiet again gets episode 2, and so on, so
-- nothing about the earlier stretch is rewritten. A withdrawn episode row is replaced by version 2 of the same
-- episode. title is empty, with title_source 'withheld', when the patient-data rule keeps the session's words out
-- (a system the registry flags, a session with no home, or a .phi folder; design, "Patient data").
CREATE TABLE session_episodes (
  id                INTEGER PRIMARY KEY,
  session_uid       TEXT    NOT NULL REFERENCES sessions (session_uid),
  episode           INTEGER NOT NULL CHECK (episode >= 1),
  began_at          TEXT    NOT NULL,
  last_activity_at  TEXT    NOT NULL,
  quiet_at          TEXT    NOT NULL,
  end_reason        TEXT    NOT NULL CHECK (end_reason IN ('session-end', 'quiet', 'killed', 'unknown')),
  folder            TEXT,                  -- working folder (a path)
  git_root          TEXT,                  -- top of the git checkout (a path)
  repo              TEXT,                  -- owner/name from the origin remote
  branch            TEXT CHECK (branch IS NULL OR length(branch) <= 250),
  worktree_path     TEXT,
  title             TEXT CHECK (title IS NULL OR length(title) <= 120),
  title_source      TEXT CHECK (title_source IS NULL OR title_source IN ('custom', 'ai', 'agent-name', 'tool', 'fallback',
                                                                    'withheld')),
  turns             INTEGER CHECK (turns IS NULL OR turns >= 0),
  version           INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  recorded_at       TEXT    NOT NULL,
  recorded_by       TEXT    NOT NULL,
  UNIQUE (session_uid, episode, version),
  CHECK (title_source IS NOT 'withheld' OR title IS NULL)
);

-- What a session touched, by name or path only: the facts the loose-ends check reads git against.
CREATE TABLE session_refs (
  id           INTEGER PRIMARY KEY,
  session_uid  TEXT    NOT NULL REFERENCES sessions (session_uid),
  episode      INTEGER NOT NULL,
  kind         TEXT    NOT NULL CHECK (kind IN ('folder', 'branch', 'commit', 'pr', 'worktree', 'file')),
  repo         TEXT    NOT NULL DEFAULT '',          -- owner/name, or '' where none applies
  value        TEXT    NOT NULL,                     -- path, branch name, commit sha or PR url
  source       TEXT    NOT NULL CHECK (source IN ('hook', 'transcript', 'git', 'daemon', 'walker', 'backfill')),
  observed_at  TEXT    NOT NULL,
  recorded_at  TEXT    NOT NULL,
  recorded_by  TEXT    NOT NULL,
  UNIQUE (session_uid, kind, repo, value)
);

-- Every tie between a session or a graph run and a ticket in Jira or Linear. The ticket itself stays in its tracker.
CREATE TABLE ticket_links (
  id           INTEGER PRIMARY KEY,
  session_uid  TEXT REFERENCES sessions (session_uid),
  run_id       TEXT REFERENCES graph_runs (run_id),
  tracker      TEXT NOT NULL CHECK (tracker IN ('jira', 'linear')),
  ticket_key   TEXT NOT NULL CHECK (ticket_key GLOB '[A-Z]*-[0-9]*' AND length(ticket_key) <= 20),
  relation     TEXT NOT NULL CHECK (relation IN ('touched', 'subject', 'created', 'duplicate-of')),
  source       TEXT NOT NULL CHECK (source IN ('branch', 'jira-command', 'daemon', 'walker', 'offer', 'josh', 'backfill')),
  linked_at    TEXT NOT NULL,
  recorded_by  TEXT NOT NULL,
  CHECK ((session_uid IS NULL) <> (run_id IS NULL))
);

-- Where a session belongs, worked out with no model (design, "How a session finds its home"). Written when the
-- session goes quiet and again whenever the answer changes (a ticket moved epic, the registry changed). The newest
-- row wins. patient_data is 1 when the home's system is flagged `patient_data: true` in conventions/registry.yaml,
-- when the system is not known, and always for a session with no home: such a session stores none of its own words.
CREATE TABLE session_homes (
  id                   INTEGER PRIMARY KEY,
  session_uid          TEXT    NOT NULL REFERENCES sessions (session_uid),
  episode              INTEGER NOT NULL,
  method               TEXT    NOT NULL CHECK (method IN ('branch', 'ticket-link', 'registry', 'unassigned')),
  tracker              TEXT CHECK (tracker IS NULL OR tracker IN ('jira', 'linear')),
  ticket_key           TEXT,
  epic_key             TEXT,
  initiative_key       TEXT,
  area                 TEXT,
  system               TEXT,               -- name from conventions/registry.yaml
  priority             TEXT    NOT NULL,   -- id from conventions/priorities.yaml (devex and unassigned included)
  evidence             TEXT    NOT NULL CHECK (length(evidence) <= 300),   -- the branch, the link id or the folder used
  conventions_version  TEXT    NOT NULL,   -- commit of conventions/ the answer was read from
  jira_read            TEXT    NOT NULL CHECK (jira_read IN ('ok', 'failed', 'not-needed')),
  patient_data         INTEGER NOT NULL CHECK (patient_data IN (0, 1)),
  derived_at           TEXT    NOT NULL,
  recorded_by          TEXT    NOT NULL,
  CHECK (method NOT IN ('branch', 'ticket-link') OR ticket_key IS NOT NULL),
  CHECK (method <> 'registry' OR (system IS NOT NULL AND ticket_key IS NULL)),
  CHECK (method <> 'unassigned' OR (priority = 'unassigned' AND ticket_key IS NULL AND system IS NULL)),
  CHECK (system IS NOT NULL OR patient_data = 1)
);

-- Cost per session and model, copied from the cost import when the session goes quiet, and again after a
-- re-pricing. The newest batch (largest computed_at) per session wins.
CREATE TABLE session_costs (
  id                  INTEGER PRIMARY KEY,
  session_uid         TEXT    NOT NULL REFERENCES sessions (session_uid),
  computed_at         TEXT    NOT NULL,
  model               TEXT    NOT NULL,
  input_tokens        INTEGER NOT NULL DEFAULT 0,
  output_tokens       INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens    INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens  INTEGER NOT NULL DEFAULT 0,
  cost_usd            REAL,
  pricing_status      TEXT    NOT NULL CHECK (pricing_status IN ('priced', 'partly-priced', 'unpriced')),
  price_set           TEXT    NOT NULL,     -- the cost import's pricing run that produced it
  recorded_by         TEXT    NOT NULL,
  UNIQUE (session_uid, computed_at, model)
);

-- Model calls Josh 360 itself makes (the summary-and-debrief call, the weekly review), so what improving costs can
-- be set against what it saves.
CREATE TABLE model_calls (
  id                   INTEGER PRIMARY KEY,
  purpose              TEXT NOT NULL CHECK (purpose IN ('summary', 'debrief', 'summary-and-debrief', 'weekly-review', 'other')),
  subject_session_uid  TEXT REFERENCES sessions (session_uid),
  model                TEXT NOT NULL,
  input_tokens         INTEGER NOT NULL DEFAULT 0,
  output_tokens        INTEGER NOT NULL DEFAULT 0,
  cost_usd             REAL,
  called_at            TEXT NOT NULL,
  recorded_by          TEXT NOT NULL
);

-- About five lines that say what the session was about and how it ended (JP-108). One per episode (the newest
-- version not withdrawn). For a session the patient-data rule covers, the lines are built only from the ledger's own
-- keys and counts (ticket, branch, pull request, turns), never from the session's words (design, "Patient data").
CREATE TABLE session_summaries (
  id             INTEGER PRIMARY KEY,
  session_uid    TEXT    NOT NULL REFERENCES sessions (session_uid),
  episode        INTEGER NOT NULL,
  method         TEXT    NOT NULL CHECK (method IN ('copied', 'model')),
  model_call_id  INTEGER REFERENCES model_calls (id),
  lines          TEXT    NOT NULL CHECK (length(lines) BETWEEN 1 AND 800
                                         AND length(lines) - length(replace(lines, char(10), '')) <= 4),
  lines_withheld INTEGER NOT NULL DEFAULT 0 CHECK (lines_withheld >= 0),   -- lines dropped by the patient-data check
  version        INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),         -- a withdrawn summary's replacement is 2
  written_at     TEXT    NOT NULL,
  recorded_by    TEXT    NOT NULL,
  UNIQUE (session_uid, episode, version),
  CHECK (method <> 'model' OR model_call_id IS NOT NULL)
);

-- The U-turns, dead ends and untold findings copied from the session's STATE.md before its 30-day clean-up. None is
-- copied for a session the patient-data rule covers.
CREATE TABLE session_state_notes (
  id           INTEGER PRIMARY KEY,
  session_uid  TEXT    NOT NULL REFERENCES sessions (session_uid),
  episode      INTEGER NOT NULL,
  kind         TEXT    NOT NULL CHECK (kind IN ('u-turn', 'dead-end', 'untold-finding')),
  note         TEXT    NOT NULL CHECK (length(note) BETWEEN 1 AND 300),
  copied_at    TEXT    NOT NULL,
  recorded_by  TEXT    NOT NULL
);

-- Friction facts (JP-112): one number per code per episode. Codes are listed in ledger/codes.json.
CREATE TABLE session_facts (
  id           INTEGER PRIMARY KEY,
  session_uid  TEXT    NOT NULL REFERENCES sessions (session_uid),
  episode      INTEGER NOT NULL,
  fact         TEXT    NOT NULL CHECK (fact GLOB '[a-z]*' AND length(fact) <= 60),
  value        INTEGER NOT NULL,
  recorded_at  TEXT    NOT NULL,
  recorded_by  TEXT    NOT NULL
);

-- Skills, agents, tools and MCP servers a session loaded and used, by name (JP-112: "used against loaded").
CREATE TABLE session_usage (
  id           INTEGER PRIMARY KEY,
  session_uid  TEXT    NOT NULL REFERENCES sessions (session_uid),
  episode      INTEGER NOT NULL,
  item_kind    TEXT    NOT NULL CHECK (item_kind IN ('skill', 'agent', 'tool', 'mcp-server', 'hook', 'rule-file')),
  item_name    TEXT    NOT NULL CHECK (length(item_name) <= 120),
  loaded       INTEGER NOT NULL CHECK (loaded IN (0, 1)),
  uses         INTEGER NOT NULL DEFAULT 0 CHECK (uses >= 0),
  recorded_at  TEXT    NOT NULL,
  recorded_by  TEXT    NOT NULL
);

-- The debrief form (JP-113): how the session ended and up to five moments, as codes and pointers.
CREATE TABLE debriefs (
  id             INTEGER PRIMARY KEY,
  session_uid    TEXT    NOT NULL REFERENCES sessions (session_uid),
  episode        INTEGER NOT NULL,
  model_call_id  INTEGER NOT NULL REFERENCES model_calls (id),
  form_version   TEXT    NOT NULL,
  ended_how      TEXT    NOT NULL CHECK (ended_how GLOB '[a-z]*' AND length(ended_how) <= 40),
  version        INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  written_at     TEXT    NOT NULL,
  recorded_by    TEXT    NOT NULL,
  UNIQUE (session_uid, episode, version)
);

CREATE TABLE debrief_moments (
  id           INTEGER PRIMARY KEY,
  debrief_id   INTEGER NOT NULL REFERENCES debriefs (id),
  n            INTEGER NOT NULL CHECK (n BETWEEN 1 AND 5),
  kind         TEXT    NOT NULL CHECK (kind GLOB '[a-z]*' AND length(kind) <= 40),
  target_kind  TEXT    NOT NULL CHECK (target_kind IN ('skill', 'rule', 'role', 'graph-step', 'system', 'tool')),
  target_name  TEXT    NOT NULL CHECK (length(target_name) <= 120),
  pointer      TEXT    NOT NULL CHECK (length(pointer) <= 80),        -- the transcript entry's id, never its text
  recorded_by  TEXT    NOT NULL,
  UNIQUE (debrief_id, n)
);

-- The one-line ticket offer (JP-110): one row when it is made, one when Josh answers.
CREATE TABLE ticket_offers (
  id           INTEGER PRIMARY KEY,
  session_uid  TEXT NOT NULL REFERENCES sessions (session_uid),
  event        TEXT NOT NULL CHECK (event IN ('offered', 'accepted', 'declined')),
  offer_trigger TEXT CHECK (offer_trigger IS NULL OR offer_trigger IN ('first-commit', 'first-branch')),
  ticket_key   TEXT,
  at           TEXT NOT NULL,
  recorded_by  TEXT NOT NULL,
  CHECK (event <> 'offered' OR offer_trigger IS NOT NULL),
  CHECK (event <> 'accepted' OR ticket_key IS NOT NULL)
);

-- Branches Josh keeps on purpose, so the loose-ends check leaves them out (JP-109). The newest mark wins.
CREATE TABLE branch_marks (
  id           INTEGER PRIMARY KEY,
  git_root     TEXT NOT NULL,
  branch       TEXT NOT NULL,
  mark         TEXT NOT NULL CHECK (mark IN ('kept', 'not-kept')),
  note         TEXT CHECK (note IS NULL OR length(note) <= 200),
  marked_at    TEXT NOT NULL,
  marked_by    TEXT NOT NULL CHECK (marked_by = 'josh'),
  recorded_by  TEXT NOT NULL
);

-- ---------------------------------------------------------------------------------------------------------------
-- Graph runs and steps (written by the walker, JP-114)
-- ---------------------------------------------------------------------------------------------------------------

-- One row per run of a graph. graph_version is the last commit that changed graphs/flows/<graph_id>.yaml;
-- repo_commit is josh-360's commit when the run started, which covers the roles, agents and gates too.
-- An external run (action-triage's PR audit, until it becomes a graph) has no graph file.
CREATE TABLE graph_runs (
  id               INTEGER PRIMARY KEY,
  run_id           TEXT NOT NULL UNIQUE,
  machine_id       TEXT NOT NULL REFERENCES machines (machine_id),
  graph_id         TEXT NOT NULL CHECK (graph_id GLOB '[a-z]*' AND length(graph_id) <= 60),
  graph_source     TEXT NOT NULL CHECK (graph_source IN ('graph-file', 'external')),
  graph_version    TEXT,
  repo_commit      TEXT,
  subject_kind     TEXT NOT NULL CHECK (subject_kind IN ('ticket', 'intake', 'pr')),
  subject_ref      TEXT NOT NULL CHECK (length(subject_ref) <= 300),   -- ticket key, intake source ref or PR url
  tracker          TEXT CHECK (tracker IS NULL OR tracker IN ('jira', 'linear')),
  ticket_key       TEXT,
  previous_run_id  TEXT REFERENCES graph_runs (run_id),               -- the last earlier run on the same ticket
  phi              INTEGER NOT NULL CHECK (phi IN (0, 1)),              -- 1: no text from this run is stored
  runner           TEXT NOT NULL CHECK (runner IN ('agent-manager', 'daemon', 'cli', 'other')),
  started_at       TEXT NOT NULL,
  recorded_by      TEXT NOT NULL,
  CHECK (graph_source <> 'graph-file' OR graph_version IS NOT NULL),
  CHECK (subject_kind <> 'ticket' OR (ticket_key IS NOT NULL AND subject_ref = ticket_key))
);

-- One row each time a step starts. attempt is the step's run count in this run (the run cap counts these).
CREATE TABLE step_runs (
  id               INTEGER PRIMARY KEY,
  run_id           TEXT    NOT NULL REFERENCES graph_runs (run_id),
  step_id          TEXT    NOT NULL CHECK (length(step_id) <= 60),
  step_kind        TEXT    NOT NULL CHECK (step_kind IN ('role', 'gate', 'ask')),
  attempt          INTEGER NOT NULL CHECK (attempt >= 1),
  loop_count       INTEGER NOT NULL CHECK (loop_count >= 0),
  tier             TEXT CHECK (tier IS NULL OR tier IN ('cheap', 'mid', 'gate')),
  role             TEXT,
  agent            TEXT,
  allowed_by_josh  INTEGER NOT NULL DEFAULT 0 CHECK (allowed_by_josh IN (0, 1)),   -- an extra run past the cap
  session_uid      TEXT REFERENCES sessions (session_uid),
  started_at       TEXT    NOT NULL,
  recorded_by      TEXT    NOT NULL,
  UNIQUE (run_id, step_id, attempt),
  CHECK ((step_kind = 'role') = (tier IS NOT NULL))
);

-- One row when a step ends. A started step with no result was cut off; the walker ends it as `_abandoned`. A
-- withdrawn result is replaced by the next version.
CREATE TABLE step_results (
  id           INTEGER PRIMARY KEY,
  step_run_id  INTEGER NOT NULL REFERENCES step_runs (id),
  outcome      TEXT    NOT NULL CHECK (length(outcome) <= 60),
  model        TEXT,                    -- the model that actually answered; empty for gate and ask steps
  session_uid  TEXT REFERENCES sessions (session_uid),
  note         TEXT CHECK (note IS NULL OR length(note) <= 200),   -- a gate's one-line summary; empty when phi
  version      INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  ended_at     TEXT    NOT NULL,
  recorded_by  TEXT    NOT NULL,
  UNIQUE (step_run_id, version)
);

-- Files a run produced or saved at closeout (spec, evidence, feedback, deliverable), by path and hash only.
CREATE TABLE run_files (
  id           INTEGER PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES graph_runs (run_id),
  step_run_id  INTEGER REFERENCES step_runs (id),
  kind         TEXT NOT NULL CHECK (kind IN ('spec', 'plan', 'evidence', 'feedback', 'deliverable', 'output')),
  name         TEXT CHECK (name IS NULL OR length(name) <= 60),      -- the step output's name, if any
  path         TEXT NOT NULL,
  sha256       TEXT CHECK (sha256 IS NULL OR length(sha256) = 64),
  saved_at     TEXT NOT NULL,
  recorded_by  TEXT NOT NULL
);

-- How a run ended. The score is copied from the end_states header of the graph version the run used, so a later
-- change to a score never rewrites old runs. A withdrawn end is replaced by the next version.
CREATE TABLE run_ends (
  id           INTEGER PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES graph_runs (run_id),
  end_name     TEXT NOT NULL CHECK (length(end_name) <= 120),        -- finished, <step>.<outcome> or exit_refused
  score        TEXT NOT NULL CHECK (score IN ('success', 'neutral', 'needs-josh')),
  version      INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  ended_at     TEXT NOT NULL,
  recorded_by  TEXT NOT NULL,
  UNIQUE (run_id, version),
  CHECK (end_name <> 'exit_refused' OR score = 'needs-josh')
);

-- Comments passed to working sessions (JP-118): the comment's id and author account, never its text.
CREATE TABLE comment_deliveries (
  id              INTEGER PRIMARY KEY,
  tracker         TEXT NOT NULL CHECK (tracker IN ('jira', 'linear')),
  ticket_key      TEXT NOT NULL,
  comment_id      TEXT NOT NULL,
  author_account  TEXT NOT NULL,
  session_uid     TEXT REFERENCES sessions (session_uid),
  run_id          TEXT REFERENCES graph_runs (run_id),
  via             TEXT NOT NULL CHECK (via IN ('binding', 'hook-file')),
  delivered_at    TEXT NOT NULL,
  recorded_by     TEXT NOT NULL,
  CHECK ((session_uid IS NULL) <> (run_id IS NULL))
);
CREATE UNIQUE INDEX comment_deliveries_once
  ON comment_deliveries (tracker, comment_id, COALESCE(session_uid, ''), COALESCE(run_id, ''));

-- ---------------------------------------------------------------------------------------------------------------
-- Josh's decisions (the decision memory, JP-116 and JP-126)
-- ---------------------------------------------------------------------------------------------------------------

-- Every question put to Josh, when it is put. An ask with no decision is still open (a parked run).
-- category is the asking step, `<graph>/<step>`, followed by `;<name>=<value>` for each detail the step's `split`
-- names, in the order it names them (JP-106 question 4, option C; graphs/CONVENTION.md, "Steps"). With no split it
-- equals question_key. Precedent is looked up by category, system and work type together, never wider, and a
-- trigger below refuses a precedent from another category.
CREATE TABLE asks (
  id                     INTEGER PRIMARY KEY,
  ask_id                 TEXT    NOT NULL UNIQUE,
  run_id                 TEXT REFERENCES graph_runs (run_id),
  step_run_id            INTEGER REFERENCES step_runs (id),
  session_uid            TEXT REFERENCES sessions (session_uid),
  category               TEXT    NOT NULL CHECK (length(category) <= 240),
  question_key           TEXT    NOT NULL CHECK (length(question_key) <= 120),   -- <graph>/<step>, the asking step
  system                 TEXT,
  work_type              TEXT,
  tracker                TEXT CHECK (tracker IS NULL OR tracker IN ('jira', 'linear')),
  ticket_key             TEXT,
  question               TEXT CHECK (question IS NULL OR length(question) <= 500),   -- empty when the run is phi
  choices                TEXT CHECK (choices IS NULL OR length(choices) <= 500),     -- a JSON list
  stage                  INTEGER NOT NULL CHECK (stage IN (1, 2, 3)),                -- the category's stage when asked
  suggested_answer       TEXT CHECK (suggested_answer IS NULL OR length(suggested_answer) <= 500),
  precedent_decision_id  INTEGER REFERENCES decisions (id),
  channel                TEXT    NOT NULL CHECK (channel IN ('needs-you', 'jira-flag', 'thread', 'terminal')),
  asked_at               TEXT    NOT NULL,
  recorded_by            TEXT    NOT NULL,
  CHECK (run_id IS NOT NULL OR session_uid IS NOT NULL),
  CHECK (suggested_answer IS NULL OR precedent_decision_id IS NOT NULL)
);

-- An answer and where it applies. At stage three the workflow answers from memory and must quote the decision it
-- rests on; a script drops any that do not (the CHECK below is the last line of that rule).
CREATE TABLE decisions (
  id                      INTEGER PRIMARY KEY,
  ask_id                  TEXT REFERENCES asks (ask_id),
  category                TEXT NOT NULL CHECK (length(category) <= 240),
  question_key            TEXT NOT NULL CHECK (length(question_key) <= 120),
  system                  TEXT,
  work_type               TEXT,
  tracker                 TEXT CHECK (tracker IS NULL OR tracker IN ('jira', 'linear')),
  ticket_key              TEXT,
  answer                  TEXT NOT NULL CHECK (length(answer) BETWEEN 1 AND 500),
  how                     TEXT NOT NULL CHECK (how IN ('answered', 'confirmed-suggestion', 'changed-suggestion',
                                                       'from-memory', 'recorded')),
  decided_by              TEXT NOT NULL CHECK (decided_by IN ('josh', 'memory')),
  rests_on_decision_id      INTEGER REFERENCES decisions (id),
  supersedes_decision_id  INTEGER REFERENCES decisions (id),
  decided_at              TEXT NOT NULL,
  recorded_by             TEXT NOT NULL,
  CHECK ((how = 'from-memory') = (decided_by = 'memory')),
  CHECK (how NOT IN ('from-memory', 'confirmed-suggestion', 'changed-suggestion') OR rests_on_decision_id IS NOT NULL)
);

-- What later happened to a decision: Josh overruled it, a newer answer superseded it, it became a written rule, or
-- it was a miss (Josh answered although this precedent was usable).
CREATE TABLE decision_events (
  id                   INTEGER PRIMARY KEY,
  decision_id          INTEGER NOT NULL REFERENCES decisions (id),
  kind                 TEXT    NOT NULL CHECK (kind IN ('overruled', 'superseded', 'promoted-to-rule', 'miss')),
  related_decision_id  INTEGER REFERENCES decisions (id),
  rule_path            TEXT CHECK (rule_path IS NULL OR length(rule_path) <= 200),   -- file in josh-360
  at                   TEXT    NOT NULL,
  event_by             TEXT    NOT NULL CHECK (event_by IN ('josh', 'script')),
  recorded_by          TEXT    NOT NULL,
  CHECK (kind <> 'promoted-to-rule' OR rule_path IS NOT NULL),
  CHECK (kind <> 'miss' OR related_decision_id IS NOT NULL)
);

-- The stage of each category of question. Only Josh's own command raises one; a category overruled after
-- promotion drops back one stage on its own. The newest row wins; a category with no row is at stage one.
CREATE TABLE category_stages (
  id           INTEGER PRIMARY KEY,
  category     TEXT    NOT NULL CHECK (length(category) <= 240),
  stage        INTEGER NOT NULL CHECK (stage IN (1, 2, 3)),
  set_by       TEXT    NOT NULL CHECK (set_by IN ('josh', 'demotion')),
  reason       TEXT CHECK (reason IS NULL OR length(reason) <= 200),
  set_at       TEXT    NOT NULL,
  recorded_by  TEXT    NOT NULL
);

-- Every precedent lookup, so "lookups that found nothing" can be counted. category is the one looked up in.
CREATE TABLE memory_lookups (
  id                INTEGER PRIMARY KEY,
  run_id            TEXT REFERENCES graph_runs (run_id),
  step_run_id       INTEGER REFERENCES step_runs (id),
  category          TEXT    NOT NULL CHECK (length(category) <= 240),
  question_key      TEXT    NOT NULL,
  system            TEXT,
  work_type         TEXT,
  found             INTEGER NOT NULL CHECK (found >= 0),
  used_decision_id  INTEGER REFERENCES decisions (id),
  looked_up_at      TEXT    NOT NULL,
  recorded_by       TEXT    NOT NULL
);

-- ---------------------------------------------------------------------------------------------------------------
-- Indexes for the agreed queries
-- ---------------------------------------------------------------------------------------------------------------

CREATE INDEX session_episodes_activity ON session_episodes (last_activity_at);
CREATE INDEX session_episodes_branch   ON session_episodes (repo, branch);
CREATE INDEX session_refs_value        ON session_refs (kind, repo, value);
CREATE INDEX ticket_links_ticket       ON ticket_links (tracker, ticket_key);
CREATE INDEX ticket_links_session      ON ticket_links (session_uid);
CREATE INDEX session_homes_session     ON session_homes (session_uid, derived_at);
CREATE INDEX session_costs_session     ON session_costs (session_uid, computed_at);
CREATE INDEX session_facts_session     ON session_facts (session_uid, episode, fact);
CREATE INDEX graph_runs_ticket         ON graph_runs (tracker, ticket_key, started_at);
CREATE INDEX graph_runs_graph          ON graph_runs (graph_id, graph_version);
CREATE INDEX step_runs_run             ON step_runs (run_id, step_id);
CREATE INDEX step_runs_session         ON step_runs (session_uid);
CREATE INDEX decisions_lookup          ON decisions (category, system, work_type, decided_at);
CREATE INDEX asks_open                 ON asks (asked_at);
CREATE INDEX corrections_row           ON corrections (table_name, row_id);

-- ---------------------------------------------------------------------------------------------------------------
-- Current views: what scripts and queries read
-- ---------------------------------------------------------------------------------------------------------------

-- The corrections in force: every correction except one that a later correction has withdrawn. A correction that
-- withdraws a correction is always in force (the triggers below refuse withdrawing it), so one level is exact.
CREATE VIEW live_corrections AS
SELECT c.* FROM corrections c
WHERE NOT EXISTS (SELECT 1 FROM corrections u WHERE u.table_name = 'corrections' AND u.row_id = c.id);

-- Each episode as it stands: its newest version not withdrawn (JP-148, A3).
CREATE VIEW current_session_episodes AS
SELECT e.* FROM session_episodes e
WHERE NOT EXISTS (SELECT 1 FROM live_corrections c WHERE c.table_name = 'session_episodes' AND c.row_id = e.id)
  AND e.version = (SELECT MAX(e2.version) FROM session_episodes e2
                     WHERE e2.session_uid = e.session_uid AND e2.episode = e.episode
                       AND NOT EXISTS (SELECT 1 FROM live_corrections c2 WHERE c2.table_name = 'session_episodes' AND c2.row_id = e2.id));

-- Each episode's summary as it stands.
CREATE VIEW current_session_summaries AS
SELECT m.* FROM session_summaries m
WHERE NOT EXISTS (SELECT 1 FROM live_corrections c WHERE c.table_name = 'session_summaries' AND c.row_id = m.id)
  AND m.version = (SELECT MAX(m2.version) FROM session_summaries m2
                     WHERE m2.session_uid = m.session_uid AND m2.episode = m.episode
                       AND NOT EXISTS (SELECT 1 FROM live_corrections c2 WHERE c2.table_name = 'session_summaries' AND c2.row_id = m2.id));

-- Each episode's debrief as it stands.
CREATE VIEW current_debriefs AS
SELECT d.* FROM debriefs d
WHERE NOT EXISTS (SELECT 1 FROM live_corrections c WHERE c.table_name = 'debriefs' AND c.row_id = d.id)
  AND d.version = (SELECT MAX(d2.version) FROM debriefs d2
                     WHERE d2.session_uid = d.session_uid AND d2.episode = d.episode
                       AND NOT EXISTS (SELECT 1 FROM live_corrections c2 WHERE c2.table_name = 'debriefs' AND c2.row_id = d2.id));

-- Each step's result as it stands.
CREATE VIEW current_step_results AS
SELECT r.* FROM step_results r
WHERE NOT EXISTS (SELECT 1 FROM live_corrections c WHERE c.table_name = 'step_results' AND c.row_id = r.id)
  AND r.version = (SELECT MAX(r2.version) FROM step_results r2
                     WHERE r2.step_run_id = r.step_run_id
                       AND NOT EXISTS (SELECT 1 FROM live_corrections c2 WHERE c2.table_name = 'step_results' AND c2.row_id = r2.id));

-- Each run's end as it stands.
CREATE VIEW current_run_ends AS
SELECT x.* FROM run_ends x
WHERE NOT EXISTS (SELECT 1 FROM live_corrections c WHERE c.table_name = 'run_ends' AND c.row_id = x.id)
  AND x.version = (SELECT MAX(x2.version) FROM run_ends x2
                     WHERE x2.run_id = x.run_id
                       AND NOT EXISTS (SELECT 1 FROM live_corrections c2 WHERE c2.table_name = 'run_ends' AND c2.row_id = x2.id));

-- The home each session has now: its newest home row that has not been retracted.
CREATE VIEW current_homes AS
SELECT h.* FROM session_homes h
WHERE NOT EXISTS (SELECT 1 FROM live_corrections c WHERE c.table_name = 'session_homes' AND c.row_id = h.id)
  AND h.id = (SELECT h2.id FROM session_homes h2
              WHERE h2.session_uid = h.session_uid
                AND NOT EXISTS (SELECT 1 FROM live_corrections c2 WHERE c2.table_name = 'session_homes' AND c2.row_id = h2.id)
              ORDER BY h2.derived_at DESC, h2.id DESC LIMIT 1);

-- Cost per session now: the newest batch per session.
CREATE VIEW current_session_costs AS
SELECT k.* FROM session_costs k
WHERE NOT EXISTS (SELECT 1 FROM live_corrections c WHERE c.table_name = 'session_costs' AND c.row_id = k.id)
  AND k.computed_at = (SELECT MAX(k2.computed_at) FROM session_costs k2
                       WHERE k2.session_uid = k.session_uid
                         AND NOT EXISTS (SELECT 1 FROM live_corrections c2 WHERE c2.table_name = 'session_costs' AND c2.row_id = k2.id));

CREATE VIEW session_cost_totals AS
SELECT session_uid, SUM(cost_usd) AS cost_usd,
       SUM(input_tokens + output_tokens + reasoning_tokens + cache_read_tokens + cache_write_tokens) AS tokens,
       CASE MAX(CASE pricing_status WHEN 'priced' THEN 0 WHEN 'partly-priced' THEN 1 ELSE 2 END)
         WHEN 0 THEN 'priced' WHEN 1 THEN 'partly-priced' ELSE 'unpriced' END AS pricing_status
FROM current_session_costs GROUP BY session_uid;

-- The convention's ledger fields, one row per step (graphs/CONVENTION.md, "The header", field `ledger`).
CREATE VIEW step_ledger AS
SELECT s.run_id AS run, s.step_id AS step, r.outcome, s.loop_count, COALESCE(r.session_uid, s.session_uid) AS session,
       s.tier, g.ticket_key AS ticket, s.started_at, r.ended_at, g.graph_version, r.model,
       s.attempt, s.allowed_by_josh, g.graph_id
FROM step_runs s
JOIN graph_runs g ON g.run_id = s.run_id
LEFT JOIN current_step_results r ON r.step_run_id = s.id
WHERE NOT EXISTS (SELECT 1 FROM live_corrections c WHERE c.table_name = 'step_runs' AND c.row_id = s.id)
  AND NOT EXISTS (SELECT 1 FROM live_corrections c WHERE c.table_name = 'graph_runs' AND c.row_id = g.id);

-- Cost per step: the cost of the session that did the step. Gate and ask steps cost nothing.
CREATE VIEW step_costs AS
SELECT l.run, l.step, l.attempt, l.graph_id, l.graph_version, l.tier, l.model, t.cost_usd
FROM step_ledger l LEFT JOIN session_cost_totals t ON t.session_uid = l.session;

-- Questions waiting on Josh: asks with no decision yet.
CREATE VIEW open_asks AS
SELECT a.* FROM asks a
WHERE NOT EXISTS (SELECT 1 FROM decisions d WHERE d.ask_id = a.ask_id AND NOT EXISTS (SELECT 1 FROM live_corrections c WHERE c.table_name = 'decisions' AND c.row_id = d.id))
  AND NOT EXISTS (SELECT 1 FROM live_corrections c WHERE c.table_name = 'asks' AND c.row_id = a.id);
CREATE VIEW current_decisions AS
SELECT d.* FROM decisions d
WHERE NOT EXISTS (SELECT 1 FROM decision_events e WHERE e.decision_id = d.id AND e.kind IN ('overruled', 'superseded')
                  AND NOT EXISTS (SELECT 1 FROM live_corrections c WHERE c.table_name = 'decision_events' AND c.row_id = e.id))
  AND NOT EXISTS (SELECT 1 FROM decisions n WHERE n.supersedes_decision_id = d.id AND NOT EXISTS (SELECT 1 FROM live_corrections c WHERE c.table_name = 'decisions' AND c.row_id = n.id))
  AND NOT EXISTS (SELECT 1 FROM live_corrections c WHERE c.table_name = 'decisions' AND c.row_id = d.id);
CREATE VIEW current_category_stages AS
SELECT s.* FROM category_stages s
WHERE s.id = (SELECT s2.id FROM category_stages s2 WHERE s2.category = s.category AND NOT EXISTS (SELECT 1 FROM live_corrections c WHERE c.table_name = 'category_stages' AND c.row_id = s2.id)
              ORDER BY s2.set_at DESC, s2.id DESC LIMIT 1);
CREATE VIEW kept_branches AS
SELECT m.git_root, m.branch, m.note, m.marked_at FROM branch_marks m
WHERE m.mark = 'kept'
  AND m.id = (SELECT m2.id FROM branch_marks m2 WHERE m2.git_root = m.git_root AND m2.branch = m.branch
              AND NOT EXISTS (SELECT 1 FROM live_corrections c WHERE c.table_name = 'branch_marks' AND c.row_id = m2.id)
              ORDER BY m2.marked_at DESC, m2.id DESC LIMIT 1);

-- ---------------------------------------------------------------------------------------------------------------
-- Integrity triggers (JP-148)
-- ---------------------------------------------------------------------------------------------------------------

-- Corrections: a row has at most one correction in force, and a correction that withdraws a correction cannot itself
-- be withdrawn (so live_corrections needs only one level). Withdrawing again after a withdrawal was undone is a new
-- correction.
CREATE TRIGGER corrections_one_in_force BEFORE INSERT ON corrections
BEGIN
  SELECT RAISE(ABORT, 'row already withdrawn: a correction for it is in force')
  WHERE EXISTS (SELECT 1 FROM live_corrections c WHERE c.table_name = NEW.table_name AND c.row_id = NEW.row_id);
END;
CREATE TRIGGER corrections_one_level BEFORE INSERT ON corrections WHEN NEW.table_name = 'corrections'
BEGIN
  SELECT RAISE(ABORT, 'a correction that withdraws a correction cannot itself be withdrawn')
  WHERE EXISTS (SELECT 1 FROM corrections t WHERE t.id = NEW.row_id AND t.table_name = 'corrections');
  SELECT RAISE(ABORT, 'no such correction')
  WHERE NOT EXISTS (SELECT 1 FROM corrections t WHERE t.id = NEW.row_id);
END;

-- Versioned tables: version n+1 of a key may be written only once version n is withdrawn (A3).
CREATE TRIGGER session_episodes_replaces_withdrawn BEFORE INSERT ON session_episodes WHEN NEW.version > 1
BEGIN
  SELECT RAISE(ABORT, 'a new version needs the version before it withdrawn: session_episodes')
  WHERE NOT EXISTS (SELECT 1 FROM session_episodes p JOIN live_corrections c ON c.table_name = 'session_episodes' AND c.row_id = p.id
                    WHERE p.session_uid = NEW.session_uid AND p.episode = NEW.episode AND p.version = NEW.version - 1);
END;
CREATE TRIGGER session_summaries_replaces_withdrawn BEFORE INSERT ON session_summaries WHEN NEW.version > 1
BEGIN
  SELECT RAISE(ABORT, 'a new version needs the version before it withdrawn: session_summaries')
  WHERE NOT EXISTS (SELECT 1 FROM session_summaries p JOIN live_corrections c ON c.table_name = 'session_summaries' AND c.row_id = p.id
                    WHERE p.session_uid = NEW.session_uid AND p.episode = NEW.episode AND p.version = NEW.version - 1);
END;
CREATE TRIGGER debriefs_replaces_withdrawn BEFORE INSERT ON debriefs WHEN NEW.version > 1
BEGIN
  SELECT RAISE(ABORT, 'a new version needs the version before it withdrawn: debriefs')
  WHERE NOT EXISTS (SELECT 1 FROM debriefs p JOIN live_corrections c ON c.table_name = 'debriefs' AND c.row_id = p.id
                    WHERE p.session_uid = NEW.session_uid AND p.episode = NEW.episode AND p.version = NEW.version - 1);
END;
CREATE TRIGGER step_results_replaces_withdrawn BEFORE INSERT ON step_results WHEN NEW.version > 1
BEGIN
  SELECT RAISE(ABORT, 'a new version needs the version before it withdrawn: step_results')
  WHERE NOT EXISTS (SELECT 1 FROM step_results p JOIN live_corrections c ON c.table_name = 'step_results' AND c.row_id = p.id
                    WHERE p.step_run_id = NEW.step_run_id AND p.version = NEW.version - 1);
END;
CREATE TRIGGER run_ends_replaces_withdrawn BEFORE INSERT ON run_ends WHEN NEW.version > 1
BEGIN
  SELECT RAISE(ABORT, 'a new version needs the version before it withdrawn: run_ends')
  WHERE NOT EXISTS (SELECT 1 FROM run_ends p JOIN live_corrections c ON c.table_name = 'run_ends' AND c.row_id = p.id
                    WHERE p.run_id = NEW.run_id AND p.version = NEW.version - 1);
END;

-- Rows about an episode name one that exists (any version). A foreign key cannot do this once an episode can have
-- versions, because SQLite needs the parent key to be unique.
CREATE TRIGGER session_refs_episode_exists BEFORE INSERT ON session_refs
BEGIN
  SELECT RAISE(ABORT, 'no such episode: session_refs')
  WHERE NOT EXISTS (SELECT 1 FROM session_episodes e WHERE e.session_uid = NEW.session_uid AND e.episode = NEW.episode);
END;
CREATE TRIGGER session_homes_episode_exists BEFORE INSERT ON session_homes
BEGIN
  SELECT RAISE(ABORT, 'no such episode: session_homes')
  WHERE NOT EXISTS (SELECT 1 FROM session_episodes e WHERE e.session_uid = NEW.session_uid AND e.episode = NEW.episode);
END;
CREATE TRIGGER session_summaries_episode_exists BEFORE INSERT ON session_summaries
BEGIN
  SELECT RAISE(ABORT, 'no such episode: session_summaries')
  WHERE NOT EXISTS (SELECT 1 FROM session_episodes e WHERE e.session_uid = NEW.session_uid AND e.episode = NEW.episode);
END;
CREATE TRIGGER session_state_notes_episode_exists BEFORE INSERT ON session_state_notes
BEGIN
  SELECT RAISE(ABORT, 'no such episode: session_state_notes')
  WHERE NOT EXISTS (SELECT 1 FROM session_episodes e WHERE e.session_uid = NEW.session_uid AND e.episode = NEW.episode);
END;
CREATE TRIGGER session_facts_episode_exists BEFORE INSERT ON session_facts
BEGIN
  SELECT RAISE(ABORT, 'no such episode: session_facts')
  WHERE NOT EXISTS (SELECT 1 FROM session_episodes e WHERE e.session_uid = NEW.session_uid AND e.episode = NEW.episode);
END;
CREATE TRIGGER session_usage_episode_exists BEFORE INSERT ON session_usage
BEGIN
  SELECT RAISE(ABORT, 'no such episode: session_usage')
  WHERE NOT EXISTS (SELECT 1 FROM session_episodes e WHERE e.session_uid = NEW.session_uid AND e.episode = NEW.episode);
END;
CREATE TRIGGER debriefs_episode_exists BEFORE INSERT ON debriefs
BEGIN
  SELECT RAISE(ABORT, 'no such episode: debriefs')
  WHERE NOT EXISTS (SELECT 1 FROM session_episodes e WHERE e.session_uid = NEW.session_uid AND e.episode = NEW.episode);
END;

-- Precedent stays inside its category (JP-106 question 4, option C; A5): a suggestion, an answer from memory and a
-- recorded lookup may only use a decision of the same category.
CREATE TRIGGER asks_precedent_same_category BEFORE INSERT ON asks WHEN NEW.precedent_decision_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'precedent from another category: asks')
  WHERE NOT EXISTS (SELECT 1 FROM decisions d WHERE d.id = NEW.precedent_decision_id AND d.category = NEW.category);
END;
CREATE TRIGGER decisions_rests_on_same_category BEFORE INSERT ON decisions WHEN NEW.rests_on_decision_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'precedent from another category: decisions')
  WHERE NOT EXISTS (SELECT 1 FROM decisions d WHERE d.id = NEW.rests_on_decision_id AND d.category = NEW.category);
END;
CREATE TRIGGER memory_lookups_same_category BEFORE INSERT ON memory_lookups WHEN NEW.used_decision_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'precedent from another category: memory_lookups')
  WHERE NOT EXISTS (SELECT 1 FROM decisions d WHERE d.id = NEW.used_decision_id AND d.category = NEW.category);
END;

-- ---------------------------------------------------------------------------------------------------------------
-- The append-only rule: every table refuses UPDATE and DELETE. (`ledger redact` drops and restores the pair for
-- one table inside one transaction, and writes a row to `redactions`.)
-- ---------------------------------------------------------------------------------------------------------------

CREATE TRIGGER schema_migrations_no_update BEFORE UPDATE ON schema_migrations BEGIN SELECT RAISE(ABORT, 'ledger is append-only: schema_migrations'); END;
CREATE TRIGGER schema_migrations_no_delete BEFORE DELETE ON schema_migrations BEGIN SELECT RAISE(ABORT, 'ledger is append-only: schema_migrations'); END;
CREATE TRIGGER machines_no_update BEFORE UPDATE ON machines BEGIN SELECT RAISE(ABORT, 'ledger is append-only: machines'); END;
CREATE TRIGGER machines_no_delete BEFORE DELETE ON machines BEGIN SELECT RAISE(ABORT, 'ledger is append-only: machines'); END;
CREATE TRIGGER corrections_no_update BEFORE UPDATE ON corrections BEGIN SELECT RAISE(ABORT, 'ledger is append-only: corrections'); END;
CREATE TRIGGER corrections_no_delete BEFORE DELETE ON corrections BEGIN SELECT RAISE(ABORT, 'ledger is append-only: corrections'); END;
CREATE TRIGGER redactions_no_update BEFORE UPDATE ON redactions BEGIN SELECT RAISE(ABORT, 'ledger is append-only: redactions'); END;
CREATE TRIGGER redactions_no_delete BEFORE DELETE ON redactions BEGIN SELECT RAISE(ABORT, 'ledger is append-only: redactions'); END;
CREATE TRIGGER sessions_no_update BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT, 'ledger is append-only: sessions'); END;
CREATE TRIGGER sessions_no_delete BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'ledger is append-only: sessions'); END;
CREATE TRIGGER session_lineage_no_update BEFORE UPDATE ON session_lineage BEGIN SELECT RAISE(ABORT, 'ledger is append-only: session_lineage'); END;
CREATE TRIGGER session_lineage_no_delete BEFORE DELETE ON session_lineage BEGIN SELECT RAISE(ABORT, 'ledger is append-only: session_lineage'); END;
CREATE TRIGGER session_episodes_no_update BEFORE UPDATE ON session_episodes BEGIN SELECT RAISE(ABORT, 'ledger is append-only: session_episodes'); END;
CREATE TRIGGER session_episodes_no_delete BEFORE DELETE ON session_episodes BEGIN SELECT RAISE(ABORT, 'ledger is append-only: session_episodes'); END;
CREATE TRIGGER session_refs_no_update BEFORE UPDATE ON session_refs BEGIN SELECT RAISE(ABORT, 'ledger is append-only: session_refs'); END;
CREATE TRIGGER session_refs_no_delete BEFORE DELETE ON session_refs BEGIN SELECT RAISE(ABORT, 'ledger is append-only: session_refs'); END;
CREATE TRIGGER ticket_links_no_update BEFORE UPDATE ON ticket_links BEGIN SELECT RAISE(ABORT, 'ledger is append-only: ticket_links'); END;
CREATE TRIGGER ticket_links_no_delete BEFORE DELETE ON ticket_links BEGIN SELECT RAISE(ABORT, 'ledger is append-only: ticket_links'); END;
CREATE TRIGGER session_homes_no_update BEFORE UPDATE ON session_homes BEGIN SELECT RAISE(ABORT, 'ledger is append-only: session_homes'); END;
CREATE TRIGGER session_homes_no_delete BEFORE DELETE ON session_homes BEGIN SELECT RAISE(ABORT, 'ledger is append-only: session_homes'); END;
CREATE TRIGGER session_costs_no_update BEFORE UPDATE ON session_costs BEGIN SELECT RAISE(ABORT, 'ledger is append-only: session_costs'); END;
CREATE TRIGGER session_costs_no_delete BEFORE DELETE ON session_costs BEGIN SELECT RAISE(ABORT, 'ledger is append-only: session_costs'); END;
CREATE TRIGGER model_calls_no_update BEFORE UPDATE ON model_calls BEGIN SELECT RAISE(ABORT, 'ledger is append-only: model_calls'); END;
CREATE TRIGGER model_calls_no_delete BEFORE DELETE ON model_calls BEGIN SELECT RAISE(ABORT, 'ledger is append-only: model_calls'); END;
CREATE TRIGGER session_summaries_no_update BEFORE UPDATE ON session_summaries BEGIN SELECT RAISE(ABORT, 'ledger is append-only: session_summaries'); END;
CREATE TRIGGER session_summaries_no_delete BEFORE DELETE ON session_summaries BEGIN SELECT RAISE(ABORT, 'ledger is append-only: session_summaries'); END;
CREATE TRIGGER session_state_notes_no_update BEFORE UPDATE ON session_state_notes BEGIN SELECT RAISE(ABORT, 'ledger is append-only: session_state_notes'); END;
CREATE TRIGGER session_state_notes_no_delete BEFORE DELETE ON session_state_notes BEGIN SELECT RAISE(ABORT, 'ledger is append-only: session_state_notes'); END;
CREATE TRIGGER session_facts_no_update BEFORE UPDATE ON session_facts BEGIN SELECT RAISE(ABORT, 'ledger is append-only: session_facts'); END;
CREATE TRIGGER session_facts_no_delete BEFORE DELETE ON session_facts BEGIN SELECT RAISE(ABORT, 'ledger is append-only: session_facts'); END;
CREATE TRIGGER session_usage_no_update BEFORE UPDATE ON session_usage BEGIN SELECT RAISE(ABORT, 'ledger is append-only: session_usage'); END;
CREATE TRIGGER session_usage_no_delete BEFORE DELETE ON session_usage BEGIN SELECT RAISE(ABORT, 'ledger is append-only: session_usage'); END;
CREATE TRIGGER debriefs_no_update BEFORE UPDATE ON debriefs BEGIN SELECT RAISE(ABORT, 'ledger is append-only: debriefs'); END;
CREATE TRIGGER debriefs_no_delete BEFORE DELETE ON debriefs BEGIN SELECT RAISE(ABORT, 'ledger is append-only: debriefs'); END;
CREATE TRIGGER debrief_moments_no_update BEFORE UPDATE ON debrief_moments BEGIN SELECT RAISE(ABORT, 'ledger is append-only: debrief_moments'); END;
CREATE TRIGGER debrief_moments_no_delete BEFORE DELETE ON debrief_moments BEGIN SELECT RAISE(ABORT, 'ledger is append-only: debrief_moments'); END;
CREATE TRIGGER ticket_offers_no_update BEFORE UPDATE ON ticket_offers BEGIN SELECT RAISE(ABORT, 'ledger is append-only: ticket_offers'); END;
CREATE TRIGGER ticket_offers_no_delete BEFORE DELETE ON ticket_offers BEGIN SELECT RAISE(ABORT, 'ledger is append-only: ticket_offers'); END;
CREATE TRIGGER branch_marks_no_update BEFORE UPDATE ON branch_marks BEGIN SELECT RAISE(ABORT, 'ledger is append-only: branch_marks'); END;
CREATE TRIGGER branch_marks_no_delete BEFORE DELETE ON branch_marks BEGIN SELECT RAISE(ABORT, 'ledger is append-only: branch_marks'); END;
CREATE TRIGGER graph_runs_no_update BEFORE UPDATE ON graph_runs BEGIN SELECT RAISE(ABORT, 'ledger is append-only: graph_runs'); END;
CREATE TRIGGER graph_runs_no_delete BEFORE DELETE ON graph_runs BEGIN SELECT RAISE(ABORT, 'ledger is append-only: graph_runs'); END;
CREATE TRIGGER step_runs_no_update BEFORE UPDATE ON step_runs BEGIN SELECT RAISE(ABORT, 'ledger is append-only: step_runs'); END;
CREATE TRIGGER step_runs_no_delete BEFORE DELETE ON step_runs BEGIN SELECT RAISE(ABORT, 'ledger is append-only: step_runs'); END;
CREATE TRIGGER step_results_no_update BEFORE UPDATE ON step_results BEGIN SELECT RAISE(ABORT, 'ledger is append-only: step_results'); END;
CREATE TRIGGER step_results_no_delete BEFORE DELETE ON step_results BEGIN SELECT RAISE(ABORT, 'ledger is append-only: step_results'); END;
CREATE TRIGGER run_files_no_update BEFORE UPDATE ON run_files BEGIN SELECT RAISE(ABORT, 'ledger is append-only: run_files'); END;
CREATE TRIGGER run_files_no_delete BEFORE DELETE ON run_files BEGIN SELECT RAISE(ABORT, 'ledger is append-only: run_files'); END;
CREATE TRIGGER run_ends_no_update BEFORE UPDATE ON run_ends BEGIN SELECT RAISE(ABORT, 'ledger is append-only: run_ends'); END;
CREATE TRIGGER run_ends_no_delete BEFORE DELETE ON run_ends BEGIN SELECT RAISE(ABORT, 'ledger is append-only: run_ends'); END;
CREATE TRIGGER comment_deliveries_no_update BEFORE UPDATE ON comment_deliveries BEGIN SELECT RAISE(ABORT, 'ledger is append-only: comment_deliveries'); END;
CREATE TRIGGER comment_deliveries_no_delete BEFORE DELETE ON comment_deliveries BEGIN SELECT RAISE(ABORT, 'ledger is append-only: comment_deliveries'); END;
CREATE TRIGGER asks_no_update BEFORE UPDATE ON asks BEGIN SELECT RAISE(ABORT, 'ledger is append-only: asks'); END;
CREATE TRIGGER asks_no_delete BEFORE DELETE ON asks BEGIN SELECT RAISE(ABORT, 'ledger is append-only: asks'); END;
CREATE TRIGGER decisions_no_update BEFORE UPDATE ON decisions BEGIN SELECT RAISE(ABORT, 'ledger is append-only: decisions'); END;
CREATE TRIGGER decisions_no_delete BEFORE DELETE ON decisions BEGIN SELECT RAISE(ABORT, 'ledger is append-only: decisions'); END;
CREATE TRIGGER decision_events_no_update BEFORE UPDATE ON decision_events BEGIN SELECT RAISE(ABORT, 'ledger is append-only: decision_events'); END;
CREATE TRIGGER decision_events_no_delete BEFORE DELETE ON decision_events BEGIN SELECT RAISE(ABORT, 'ledger is append-only: decision_events'); END;
CREATE TRIGGER category_stages_no_update BEFORE UPDATE ON category_stages BEGIN SELECT RAISE(ABORT, 'ledger is append-only: category_stages'); END;
CREATE TRIGGER category_stages_no_delete BEFORE DELETE ON category_stages BEGIN SELECT RAISE(ABORT, 'ledger is append-only: category_stages'); END;
CREATE TRIGGER memory_lookups_no_update BEFORE UPDATE ON memory_lookups BEGIN SELECT RAISE(ABORT, 'ledger is append-only: memory_lookups'); END;
CREATE TRIGGER memory_lookups_no_delete BEFORE DELETE ON memory_lookups BEGIN SELECT RAISE(ABORT, 'ledger is append-only: memory_lookups'); END;
