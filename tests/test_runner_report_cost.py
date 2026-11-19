"""JP-170: the run report's cost column, with each step's subagents rolled in. Made-up sessions and prices only."""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_runner_report as trr  # noqa: E402
from runner_helpers import RunnerCase  # noqa: E402
from runner_lib import status  # noqa: E402

NOW = "2026-11-17T12:00:00Z"


class ReportCost(RunnerCase):
    conn, snap, report, finished_run = (trr.Reporting.conn, trr.Reporting.snap, trr.Reporting.report,
                                        trr.Reporting.finished_run)

    def priced_run(self):
        run = self.finished_run()
        conn = self.conn()
        try:
            main = conn.execute("SELECT session_uid, machine_id FROM sessions WHERE tool_session_id = 'sess-0001'").fetchone()
            sub = "{}:claude-code:sess-0099".format(main[1])
            conn.execute("INSERT INTO sessions (session_uid, machine_id, tool, tool_session_id, started_at, started_by, "
                         "recorded_at, recorded_by) VALUES (?, ?, 'claude-code', 'sess-0099', ?, 'walker', ?, 't')",
                         (sub, main[1], NOW, NOW))
            conn.execute("INSERT INTO session_lineage (child_uid, parent_uid, root_uid, kind, confidence, discovered_at, "
                         "recorded_by) VALUES (?, ?, ?, 'subagent', 'confirmed', ?, 't')", (sub, main[0], main[0], NOW))
            for uid, usd in ((main[0], 3.40), (sub, 0.60)):
                conn.execute("INSERT INTO session_costs (session_uid, computed_at, model, cost_usd, pricing_status, "
                             "price_set, recorded_by) VALUES (?, ?, 'm', ?, 'priced', '1', 't')", (uid, NOW, usd))
            conn.commit()
        finally:
            conn.close()
        return run

    def report_with_cost(self, run):
        conn = self.conn()
        try:
            return status.run_report(conn, run, self.root, with_cost=True)
        finally:
            conn.close()

    def test_each_step_shows_its_cost_with_its_subagents(self):
        run = self.priced_run()
        report = self.report_with_cost(run)
        role = [s for s in report["steps"] if s["session"] == "sess-0001"]
        self.assertTrue(role)
        self.assertEqual({s["cost_usd"] for s in role}, {4.0})
        self.assertEqual({s["cost_pricing"] for s in role}, {"priced"})
        build = [s for s in report["steps"] if s["step"] == "build"][0]
        self.assertIn("$4.00", [l for l in status.render(report).splitlines() if l.startswith("| build |")][0])
        self.assertEqual(build["cost_usd"], 4.0)

    def test_a_step_with_no_session_has_no_cost(self):
        run = self.priced_run()
        gates = [s for s in self.report_with_cost(run)["steps"] if s["kind"] != "role"]
        self.assertTrue(gates)
        self.assertEqual({s["cost_usd"] for s in gates}, {None})
        self.assertEqual({s["cost_pricing"] for s in gates}, {None})

    def test_a_session_with_no_price_says_not_priced_yet(self):
        run = self.finished_run()
        report = self.report_with_cost(run)
        out = status.render(report)
        self.assertIn("not priced yet", out)
        self.assertNotIn("$0", out)

    def test_the_header_has_a_cost_column_after_the_session(self):
        out = status.render(self.report_with_cost(self.priced_run()))
        header = [l for l in out.splitlines() if l.startswith("| Step")][0]
        cells = [c.strip() for c in header.strip("|").split("|")]
        self.assertEqual(cells[cells.index("Session") + 1], "Cost")

    def test_a_published_snapshot_has_no_cost_and_the_report_says_so(self):
        run = self.priced_run()
        snap = self.snap()
        self.assertEqual(snap["ticket_counts"]["cost_fields"], 0)    # JP-172: the counter the validation watch reads
        bare = dict(snap, ticket_counts={k: v for k, v in snap["ticket_counts"].items() if k != "cost_fields"})
        self.assertNotIn("cost", json.dumps(bare).lower())            # the published snapshot never carries cost
        self.assertNotIn("4.0", json.dumps(snap))
        # from a snapshot the report has a dash in the column and a line saying why
        snap["ended_runs"] = [dict(e) for e in snap["ended_runs"]]
        report = status.report_from_snapshot(snap, run)
        out = status.render(report)
        self.assertIn("not in a published snapshot", out)
        self.assertNotIn("$", out)

    def test_the_command_shows_the_cost(self):
        import io
        import runner
        run = self.priced_run()
        out = io.StringIO()
        self.assertEqual(runner.main(["report", "--run", run, "--graphs-root", str(self.root)], out), 0)
        build = [l for l in out.getvalue().splitlines() if l.startswith("| build |")][0]
        self.assertIn("$4.00", build)
        out = io.StringIO()
        runner.main(["report", "--run", run, "--json", "--graphs-root", str(self.root)], out)
        self.assertEqual({s["cost_usd"] for s in json.loads(out.getvalue())["steps"] if s["step"] == "build"}, {4.0})

    def test_the_report_without_cost_asked_for_carries_none(self):
        run = self.priced_run()
        report = self.report(run)
        self.assertTrue(all("cost_usd" not in s for s in report["steps"]))


if __name__ == "__main__":
    unittest.main()
