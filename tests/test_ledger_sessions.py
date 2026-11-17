import unittest

from tests.ledger_helpers import LedgerCase, NOW, T
from ledger import sessions


class EnsureTests(LedgerCase):
    def call(self, **over):
        args = dict(tool="claude-code", tool_session_id="sess-0001", started_at=T, started_by="josh", now=NOW,
                    by="test")
        args.update(over)
        return sessions.ensure(self.conn, **args)

    def test_ensure_writes_once(self):
        first = self.call()
        second = self.call()
        self.assertEqual(first, second)
        self.assertEqual(first, self.uid("sess-0001"))
        self.assertEqual(self.count("sessions"), 1)

    def test_ensure_after_the_recorder_changes_nothing(self):
        self.call(started_by="walker", started_at=T)
        self.call(started_by="unknown", started_at="2026-11-17T11:00:00Z")
        row = self.rows("SELECT started_by, started_at FROM sessions")[0]
        self.assertEqual(row, ("walker", T))

    def test_unknown_starter_is_recorded_as_unknown(self):
        self.call(started_by="somebody-new")
        self.assertEqual(self.rows("SELECT started_by FROM sessions")[0][0], "unknown")

    def test_unknown_tool_and_empty_id_are_refused(self):
        with self.assertRaises(ValueError):
            self.call(tool="notepad")
        with self.assertRaises(ValueError):
            self.call(tool_session_id="")

    def test_a_step_run_can_point_at_the_new_row(self):
        uid = self.call()
        self.conn.execute(
            "INSERT INTO graph_runs (run_id, machine_id, graph_id, graph_source, graph_version, subject_kind, "
            "subject_ref, phi, runner, started_at, recorded_by) "
            "VALUES ('r-1', ?, 'dev', 'graph-file', '1', 'intake', 'made-up', 0, 'cli', ?, 'test')",
            (self.machine, T))
        self.conn.execute(
            "INSERT INTO step_runs (run_id, step_id, step_kind, attempt, loop_count, session_uid, started_at, "
            "recorded_by) VALUES ('r-1', 'check', 'gate', 1, 0, ?, ?, 'test')", (uid, T))
        self.assertEqual(self.count("step_runs"), 1)


if __name__ == "__main__":
    unittest.main()
