"""JP-107, Task 6: cost, links and titles copied from the cost ledger. A made-up cost ledger, built here from the
column list in claude-360/src/costledger/db.ts, holds made-up rows."""
import sqlite3
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ledger_helpers import NOW, LedgerCase  # noqa: E402
from ledger import costs  # noqa: E402

COST_DDL = """
CREATE TABLE messages (id INTEGER PRIMARY KEY, tool TEXT NOT NULL, source_message_id TEXT NOT NULL,
  source_session_id TEXT, source_agent_id TEXT, ts_utc TEXT NOT NULL, model_raw TEXT NOT NULL, provider_raw TEXT,
  input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER, cache_read_tokens INTEGER,
  cache_write_5m_tokens INTEGER, cache_write_1h_tokens INTEGER, cache_write_unclassified_tokens INTEGER,
  logged_cost_usd REAL, is_sidechain INTEGER NOT NULL DEFAULT 0, cwd TEXT, git_branch TEXT, repo_key TEXT,
  worktree_path TEXT, attribution_quality TEXT NOT NULL DEFAULT 'x', usage_status TEXT NOT NULL DEFAULT 'x',
  suspect INTEGER NOT NULL DEFAULT 0, source_path TEXT NOT NULL DEFAULT 'p', source_locator TEXT NOT NULL DEFAULT 'l');
CREATE TABLE pricing_runs (id INTEGER PRIMARY KEY, started_at TEXT NOT NULL, note TEXT);
CREATE TABLE message_costs (run_id INTEGER NOT NULL, message_id INTEGER NOT NULL, model_id TEXT,
  computed_cost_usd REAL, price_ids TEXT, pricing_status TEXT NOT NULL, PRIMARY KEY (run_id, message_id));
CREATE TABLE jira_session_links (issue_key TEXT NOT NULL, tool TEXT NOT NULL, source_session_id TEXT NOT NULL,
  action TEXT NOT NULL, recorded_at TEXT NOT NULL, PRIMARY KEY (issue_key, tool, source_session_id));
CREATE TABLE session_labels (tool TEXT NOT NULL, source_session_id TEXT NOT NULL, kind TEXT NOT NULL,
  value TEXT NOT NULL, recorded_at TEXT NOT NULL, PRIMARY KEY (tool, source_session_id, kind));
CREATE TABLE session_pr_links (tool TEXT NOT NULL, source_session_id TEXT NOT NULL, url TEXT NOT NULL,
  repository TEXT, number TEXT, recorded_at TEXT NOT NULL, PRIMARY KEY (tool, source_session_id, url));
"""


def cost_ledger():
    db = sqlite3.connect(":memory:")
    db.executescript(COST_DDL)
    db.execute("INSERT INTO pricing_runs (id, started_at) VALUES (1, '2026-11-17T08:00:00Z')")
    return db


def message(db, mid, session="sess-0001", model="model-a", cost=1.5, status="priced", agent=None, inp=100, out=10,
            run=1):
    db.execute("INSERT INTO messages (id, tool, source_message_id, source_session_id, source_agent_id, ts_utc, "
               "model_raw, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_5m_tokens, "
               "cache_write_1h_tokens, cache_write_unclassified_tokens) "
               "VALUES (?, 'claude-code', ?, ?, ?, '2026-11-17T09:00:00Z', ?, ?, ?, 1, 2, 3, 4, 5)",
               (mid, "m%d" % mid, session, agent, model, inp, out))
    db.execute("INSERT INTO message_costs (run_id, message_id, model_id, computed_cost_usd, pricing_status) "
               "VALUES (?, ?, ?, ?, ?)", (run, mid, model, cost if status == "priced" else None, status))


class Costs(LedgerCase):
    def setUp(self):
        super().setUp()
        self.uid_ = self.session()
        self.episode(self.uid_)
        self.cdb = cost_ledger()

    def copy(self, now=NOW):
        return costs.copy_costs(self.conn, self.cdb, self.uid_, "sess-0001", now)

    def test_cost_per_model_is_copied_with_its_pricing_run(self):
        message(self.cdb, 1, model="model-a", cost=1.5)
        message(self.cdb, 2, model="model-a", cost=0.5)
        message(self.cdb, 3, model="model-b", cost=2.0)
        self.assertEqual(self.copy(), 2)
        rows = self.rows("SELECT model, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, "
                         "cache_write_tokens, cost_usd, pricing_status, price_set FROM session_costs ORDER BY model")
        self.assertEqual(rows, [("model-a", 200, 20, 2, 4, 24, 2.0, "priced", "1"),
                                ("model-b", 100, 10, 1, 2, 12, 2.0, "priced", "1")])

    def test_partly_priced_session_says_so(self):
        message(self.cdb, 1, cost=1.0)
        message(self.cdb, 2, status="missing_price")
        message(self.cdb, 3, model="model-c", status="missing_alias")
        self.copy()
        self.assertEqual(self.rows("SELECT model, cost_usd, pricing_status FROM session_costs ORDER BY model"),
                         [("model-a", 1.0, "partly-priced"), ("model-c", None, "unpriced")])
        self.assertEqual(self.rows("SELECT pricing_status FROM session_cost_totals"), [("unpriced",)])

    def test_unchanged_cost_is_not_copied_again(self):
        message(self.cdb, 1)
        self.copy()
        self.assertEqual(self.copy(now="2026-11-17T13:00:00Z"), 0)
        self.assertEqual(self.count("session_costs"), 1)

    def test_repriced_session_adds_a_new_batch_and_current_view_shows_it(self):
        message(self.cdb, 1, cost=1.0)
        self.copy()
        self.cdb.execute("INSERT INTO pricing_runs (id, started_at) VALUES (2, '2026-11-17T12:30:00Z')")
        self.cdb.execute("INSERT INTO message_costs (run_id, message_id, model_id, computed_cost_usd, pricing_status) "
                         "VALUES (2, 1, 'model-a', 3.0, 'priced')")
        self.assertEqual(self.copy(now="2026-11-17T13:00:00Z"), 1)
        self.assertEqual(self.count("session_costs"), 2)
        self.assertEqual(self.rows("SELECT cost_usd, price_set FROM current_session_costs"), [(3.0, "2")])

    def test_more_usage_adds_a_new_batch(self):
        message(self.cdb, 1)
        self.copy()
        message(self.cdb, 2)
        self.assertEqual(self.copy(now="2026-11-17T13:00:00Z"), 1)

    def test_a_subagents_cost_is_its_own_and_not_the_parents(self):
        message(self.cdb, 1, inp=100)
        message(self.cdb, 2, inp=7, agent="ab12")
        self.copy()
        self.assertEqual(self.rows("SELECT input_tokens FROM session_costs"), [(100,)])
        child = self.session("sess-0001+agent-ab12")
        costs.copy_costs(self.conn, self.cdb, child, "sess-0001+agent-ab12", NOW)
        self.assertEqual(self.rows("SELECT input_tokens FROM session_costs WHERE session_uid = ?", (child,)),
                         [(7,)])

    def test_missing_cost_ledger_records_the_session_anyway(self):
        self.assertEqual(costs.copy_costs(self.conn, None, self.uid_, "sess-0001", NOW), 0)
        self.assertEqual(costs.copy_links(self.conn, None, self.uid_, "sess-0001", 1, NOW), 0)
        self.assertEqual(costs.session_title(None, "sess-0001"), (None, None))
        self.assertIsNone(costs.open_cost_ledger(self.tmp / "no-such" / "ledger.db"))
        self.assertEqual(self.count("sessions"), 1)

    def test_a_cost_ledger_file_opens_read_only(self):
        path = self.tmp / "cost.db"
        raw = sqlite3.connect(str(path))
        raw.executescript(COST_DDL)
        raw.commit()
        raw.close()
        empty = self.tmp / "empty.db"
        sqlite3.connect(str(empty)).close()
        self.assertIsNone(costs.open_cost_ledger(empty))  # no pricing_runs table: unreadable, not an error
        db = costs.open_cost_ledger(path)
        self.assertIsNotNone(db)
        with self.assertRaises(sqlite3.OperationalError):
            db.execute("INSERT INTO pricing_runs (id, started_at) VALUES (2, 'y')")

    def test_jira_links_are_copied_as_touched(self):
        self.cdb.execute("INSERT INTO jira_session_links VALUES ('JP-900', 'claude-code', 'sess-0001', 'worked', ?)",
                         ("2026-11-17T09:05:00Z",))
        self.cdb.execute("INSERT INTO jira_session_links VALUES ('JP-901', 'claude-code', 'other', 'worked', ?)",
                         ("2026-11-17T09:05:00Z",))
        self.cdb.execute("INSERT INTO session_pr_links VALUES ('claude-code', 'sess-0001', "
                         "'https://example.test/o/r/pull/9', 'o/r', '9', '2026-11-17T09:06:00Z')")
        self.assertEqual(costs.copy_links(self.conn, self.cdb, self.uid_, "sess-0001", 1, NOW), 2)
        self.assertEqual(self.rows("SELECT tracker, ticket_key, relation, source, linked_at FROM ticket_links"),
                         [("jira", "JP-900", "touched", "jira-command", "2026-11-17T09:05:00Z")])
        self.assertEqual(self.rows("SELECT kind, repo, value FROM session_refs"),
                         [("pr", "o/r", "https://example.test/o/r/pull/9")])
        self.assertEqual(costs.copy_links(self.conn, self.cdb, self.uid_, "sess-0001", 1, NOW), 0)

    def test_labels_come_best_first(self):
        for kind, value in (("tool_title", "t"), ("agent_name", "a"), ("ai_title", "ai")):
            self.cdb.execute("INSERT INTO session_labels VALUES ('claude-code', 'sess-0001', ?, ?, ?)",
                             (kind, value, NOW))
        self.assertEqual(costs.session_title(self.cdb, "sess-0001"), ("ai", "ai"))
        self.cdb.execute("INSERT INTO session_labels VALUES ('claude-code', 'sess-0001', 'custom_title', 'c', ?)",
                         (NOW,))
        self.assertEqual(costs.session_title(self.cdb, "sess-0001"), ("c", "custom"))


class DefaultPath(unittest.TestCase):
    """JP-111: the cost tables moved into cache.db; the old cost ledger is the fallback until the cutover has run."""

    def setUp(self):
        import os
        import tempfile
        self.tmp = Path(tempfile.mkdtemp(prefix="josh360-costpath-"))
        self.old_env = os.environ.get("JOSH360_HOME")
        os.environ["JOSH360_HOME"] = str(self.tmp / "j360")
        self.claude = self.tmp / ".claude"

    def tearDown(self):
        import os
        import shutil
        if self.old_env is None:
            os.environ.pop("JOSH360_HOME", None)
        else:
            os.environ["JOSH360_HOME"] = self.old_env
        shutil.rmtree(str(self.tmp), ignore_errors=True)

    def make(self, path):
        path.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(str(path))
        db.executescript(COST_DDL)
        db.commit()
        db.close()

    def test_falls_back_to_the_old_cost_ledger_before_cutover(self):
        self.assertEqual(costs.default_path(self.claude), self.claude / "cost-ledger" / "ledger.db")

    def test_uses_cache_db_once_it_holds_the_cost_tables(self):
        new = self.tmp / "j360" / "state" / "cache.db"
        self.make(new)
        db = sqlite3.connect(str(new))
        db.execute("INSERT INTO pricing_runs (id, started_at) VALUES (1, '2026-11-17T08:00:00Z')")
        db.commit()
        db.close()
        self.assertEqual(costs.default_path(self.claude), new)

    def test_a_cache_db_with_the_tables_but_no_pricing_run_is_not_used(self):
        # the Jira hook creates exactly this before the cutover has seeded the old history
        new = self.tmp / "j360" / "state" / "cache.db"
        self.make(new)
        self.assertEqual(costs.default_path(self.claude), self.claude / "cost-ledger" / "ledger.db")

    def test_a_cache_db_without_cost_tables_is_not_used(self):
        new = self.tmp / "j360" / "state" / "cache.db"
        new.parent.mkdir(parents=True)
        sqlite3.connect(str(new)).close()
        self.assertEqual(costs.default_path(self.claude), self.claude / "cost-ledger" / "ledger.db")


if __name__ == "__main__":
    unittest.main()
