"""JP-174: the doctor's `graphs.stale-worktrees` check, on a made-up home, registry and ledger (clock 17 Nov 2026)."""
import json
import unittest

import doctor_helpers as h

ID = "graphs.stale-worktrees"


class StaleWorktrees(h.DoctorCase):
    def setUp(self):
        super().setUp()
        self.clone = self.user / "dev" / "app"
        (self.clone / ".claude" / "worktrees").mkdir(parents=True)
        path = self.copy / "conventions" / "registry.json"
        doc = json.loads(path.read_text())
        doc["systems"].append({"name": "made-up-app", "folders": ["~/dev/app"], "repositories": ["app"]})
        path.write_text(json.dumps(doc))
        self.runs = 0

    def tree(self, name):
        (self.clone / ".claude" / "worktrees" / name).mkdir()

    def graph_run(self, ticket, ended_at=None, graph="development"):
        self.runs += 1
        run = "r-{:012d}".format(self.runs)
        conn = h.ledger_db.connect(self.home / "state" / "ledger.db")
        machine = h.ledger_db.machine_id(conn)
        conn.execute(
            "INSERT INTO graph_runs (run_id, machine_id, graph_id, graph_source, graph_version, subject_kind, "
            "subject_ref, tracker, ticket_key, phi, runner, started_at, recorded_by) "
            "VALUES (?, ?, ?, 'graph-file', 'abc123', 'ticket', ?, 'jira', ?, 0, 'agent-manager', ?, 'test')",
            (run, machine, graph, ticket, ticket, "2026-11-01T00:00:00Z"))
        if ended_at:
            conn.execute("INSERT INTO run_ends (run_id, end_name, score, version, ended_at, recorded_by) "
                         "VALUES (?, 'stop', 'neutral', 1, ?, 'test')", (run, ended_at))
        conn.commit()
        conn.close()

    def result(self):
        return self.results()[ID]

    def test_no_worktrees_passes(self):
        r = self.result()
        self.assertEqual(r.status, "pass", r.detail)
        self.assertIn("no graph worktrees", r.detail)

    # -- Scenario: The doctor finds a stale worktree -------------------------------------------------------------
    def test_a_worktree_left_8_days_after_its_run_warns_and_one_left_6_days_does_not(self):
        self.tree("JP-902-x")
        self.graph_run("JP-902", "2026-11-09T20:00:00Z")      # 8 days before the clock
        self.tree("JP-906-y")
        self.graph_run("JP-906", "2026-11-11T20:00:00Z")      # 6 days
        r = self.result()
        self.assertEqual(r.status, "warn", r.detail)
        self.assertIn("JP-902-x", r.detail)
        self.assertNotIn("JP-906-y", r.detail)
        self.assertIn("~/dev/app", r.detail)
        self.assertIn("closeout", r.fix)

    def test_the_newest_run_counts(self):
        self.tree("JP-902-x")
        self.graph_run("JP-902", "2026-11-01T20:00:00Z")
        self.graph_run("JP-902", "2026-11-15T20:00:00Z")
        self.assertEqual(self.result().status, "pass")

    def test_a_ticket_with_an_open_run_is_not_stale(self):
        self.tree("JP-902-x")
        self.graph_run("JP-902", "2026-11-01T20:00:00Z")
        self.graph_run("JP-902")                              # open, a stopped run included
        self.assertEqual(self.result().status, "pass")

    def test_a_worktree_no_graph_made_is_not_the_graphs(self):
        self.tree("JP-950-by-hand")
        self.tree("scratch")
        r = self.result()
        self.assertEqual(r.status, "pass", r.detail)

    def test_an_unreadable_ledger_warns_rather_than_passing(self):
        self.tree("JP-902-x")
        (self.home / "state" / "ledger.db").unlink()
        r = self.result()
        self.assertEqual(r.status, "warn")
        self.assertIn("ledger cannot be read", r.detail)

    def test_an_unreadable_registry_warns(self):
        (self.copy / "conventions" / "registry.json").write_text("{not json")
        self.assertEqual(self.result().status, "warn")


if __name__ == "__main__":
    unittest.main()
