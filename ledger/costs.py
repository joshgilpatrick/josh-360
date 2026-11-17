"""Copy cost, ticket links and titles from the cost ledger into the ledger (JP-107, Task 6). Python 3.9, stdlib only.

The cost tables live in `~/.josh-360/state/cache.db`, written by the cost import in apps/session-atlas (JP-111; before
that they were `~/.claude/cost-ledger/ledger.db`, which `default_path` still falls back to until the cutover has run).
They are opened read-only and never changed. Nothing here prices a message: the newest `pricing_runs` row already did.

  - copy_costs   one `session_costs` row per model, as a batch stamped `now`. A session whose figures are unchanged
                 since its last batch gets no new batch; a re-pricing or more usage gets a new one, and the
                 `current_session_costs` view shows the newest.
  - copy_links   `jira_session_links` become `ticket_links` (touched, jira-command) and `session_pr_links` become
                 `pr` refs.
  - session_title  the cost ledger's own label for a session, for when the transcript gave none.
"""
from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Dict, List, Optional, Tuple

BY = "ledger/costs.py"
LABEL_ORDER = (("custom_title", "custom"), ("ai_title", "ai"), ("agent_name", "agent-name"), ("tool_title", "tool"))
NOT_PRICED_AND_NOT_EMPTY = ("missing_price", "missing_alias", "suspect")


def default_path(claude_home: Path) -> Path:
    """Where the cost tables are now: cache.db under JOSH360_HOME (default ~/.josh-360), else the old cost ledger."""
    from laptop import common
    new = common.state_dir() / "cache.db"
    return new if open_cost_ledger(new) is not None else claude_home / "cost-ledger" / "ledger.db"


def open_cost_ledger(path: Path) -> Optional[sqlite3.Connection]:
    """The cost ledger read-only, or None when it is missing or unreadable (the session is recorded anyway)."""
    try:
        if not path.is_file():
            return None
        conn = sqlite3.connect("file:{}?mode=ro".format(path), uri=True, timeout=5.0)
        conn.execute("SELECT 1 FROM pricing_runs LIMIT 1")
        return conn
    except sqlite3.Error:
        return None


def _agent_filter(tool_session_id: str) -> Tuple[str, List[str]]:
    """The SQL that picks one session's messages. A subagent's id is <parent>+<agent id>; a main session excludes
    its subagents, which have their own rows."""
    if "+" in tool_session_id:
        parent, agent = tool_session_id.split("+", 1)
        bare = agent[len("agent-"):] if agent.startswith("agent-") else agent
        return ("m.source_session_id = ? AND m.source_agent_id IN (?, ?)", [parent, agent, bare])
    return ("m.source_session_id = ? AND COALESCE(m.source_agent_id, '') = ''", [tool_session_id])


def _batch(cost_db: sqlite3.Connection, tool_session_id: str) -> Tuple[Optional[int], Dict[str, dict]]:
    run = cost_db.execute("SELECT MAX(id) FROM pricing_runs").fetchone()[0]
    if run is None:
        return None, {}
    where, args = _agent_filter(tool_session_id)
    rows = cost_db.execute(
        """SELECT COALESCE(c.model_id, m.model_raw), COALESCE(m.input_tokens, 0), COALESCE(m.output_tokens, 0),
                  COALESCE(m.reasoning_tokens, 0), COALESCE(m.cache_read_tokens, 0),
                  COALESCE(m.cache_write_5m_tokens, 0) + COALESCE(m.cache_write_1h_tokens, 0)
                    + COALESCE(m.cache_write_unclassified_tokens, 0),
                  c.computed_cost_usd, COALESCE(c.pricing_status, 'missing_price')
           FROM messages m LEFT JOIN message_costs c ON c.message_id = m.id AND c.run_id = ?
           WHERE m.tool = 'claude-code' AND """ + where, [run] + args).fetchall()
    models: Dict[str, dict] = {}
    for model, inp, out, reason, cread, cwrite, cost, status in rows:
        if status == "no_usage":
            continue
        m = models.setdefault(model or "unknown", {"input": 0, "output": 0, "reasoning": 0, "cache_read": 0,
                                                    "cache_write": 0, "cost": None, "priced": 0, "all": 0})
        m["input"] += inp
        m["output"] += out
        m["reasoning"] += reason
        m["cache_read"] += cread
        m["cache_write"] += cwrite
        m["all"] += 1
        if status == "priced" and cost is not None:
            m["priced"] += 1
            m["cost"] = (m["cost"] or 0.0) + cost
    return run, models


def _status(m: dict) -> str:
    if m["priced"] == m["all"]:
        return "priced"
    return "unpriced" if m["priced"] == 0 else "partly-priced"


def copy_costs(conn: sqlite3.Connection, cost_db: Optional[sqlite3.Connection], uid: str, tool_session_id: str,
               now: str) -> int:
    """Rows written to session_costs. None for the cost ledger (missing) writes nothing and is not an error."""
    if cost_db is None:
        return 0
    run, models = _batch(cost_db, tool_session_id)
    if not models:
        return 0
    newest = conn.execute("SELECT MAX(computed_at) FROM current_session_costs WHERE session_uid = ?",
                          (uid,)).fetchone()[0]
    if newest is not None:
        old = {r[0]: r[1:] for r in conn.execute(
            "SELECT model, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, "
            "cost_usd, pricing_status, price_set FROM current_session_costs WHERE session_uid = ?", (uid,))}
        new = {name: (m["input"], m["output"], m["reasoning"], m["cache_read"], m["cache_write"],
                      None if m["cost"] is None else round(m["cost"], 9), _status(m), str(run))
               for name, m in models.items()}
        if {k: v[:5] + ((None if v[5] is None else round(v[5], 9)),) + v[6:] for k, v in old.items()} == new:
            return 0
    written = 0
    for name, m in sorted(models.items()):
        before = conn.total_changes
        conn.execute(
            "INSERT OR IGNORE INTO session_costs (session_uid, computed_at, model, input_tokens, output_tokens, "
            "reasoning_tokens, cache_read_tokens, cache_write_tokens, cost_usd, pricing_status, price_set, "
            "recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (uid, now, name, m["input"], m["output"], m["reasoning"], m["cache_read"], m["cache_write"], m["cost"],
             _status(m), str(run), BY))
        written += conn.total_changes - before
    return written


def copy_links(conn: sqlite3.Connection, cost_db: Optional[sqlite3.Connection], uid: str, tool_session_id: str,
               episode: int, now: str, by: str = BY, source: str = "transcript") -> int:
    """Ticket links and pull request refs the cost ledger saw for this session. Rows written. The backfill passes
    source "backfill", which marks both the ticket links and the refs as copied from rows already there."""
    link_source = "backfill" if source == "backfill" else "jira-command"
    if cost_db is None:
        return 0
    source_id = tool_session_id.split("+", 1)[0]
    written = 0
    for key, recorded_at in cost_db.execute(
            "SELECT issue_key, recorded_at FROM jira_session_links WHERE tool = 'claude-code' "
            "AND source_session_id = ? ORDER BY issue_key", (source_id,)).fetchall():
        exists = conn.execute("SELECT 1 FROM ticket_links WHERE session_uid = ? AND ticket_key = ? "
                              "AND source = ?", (uid, key, link_source)).fetchone()
        if exists:
            continue
        conn.execute("INSERT INTO ticket_links (session_uid, tracker, ticket_key, relation, source, linked_at, "
                     "recorded_by) VALUES (?, 'jira', ?, 'touched', ?, ?, ?)",
                     (uid, key, link_source, recorded_at or now, by))
        written += 1
    for url, repository, recorded_at in cost_db.execute(
            "SELECT url, COALESCE(repository, ''), recorded_at FROM session_pr_links WHERE tool = 'claude-code' "
            "AND source_session_id = ? ORDER BY url", (source_id,)).fetchall():
        before = conn.total_changes
        conn.execute("INSERT OR IGNORE INTO session_refs (session_uid, episode, kind, repo, value, source, "
                     "observed_at, recorded_at, recorded_by) VALUES (?, ?, 'pr', ?, ?, ?, ?, ?, ?)",
                     (uid, episode, repository, url, source, recorded_at or now, now, by))
        written += conn.total_changes - before
    return written


def session_title(cost_db: Optional[sqlite3.Connection], tool_session_id: str) -> Tuple[Optional[str], Optional[str]]:
    """(title, source) from the cost ledger's labels for this session, best first, or (None, None). The caller must
    still pass the text through the patient-data screen and the .phi rule."""
    if cost_db is None:
        return None, None
    found = dict(cost_db.execute("SELECT kind, value FROM session_labels WHERE tool = 'claude-code' "
                                 "AND source_session_id = ?", (tool_session_id.split("+", 1)[0],)).fetchall())
    for kind, source in LABEL_ORDER:
        if found.get(kind):
            return found[kind], source
    return None, None
