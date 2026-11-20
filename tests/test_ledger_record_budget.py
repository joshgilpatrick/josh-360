"""JP-181: the recorder stops on a time budget, saves its progress as it goes, and reads each ticket from Jira once.

Made-up sessions, folders and tickets only; a made-up clock stands in for time, and Jira is a counting function.
"""
import calendar
import copy
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ledger_transcripts as tr  # noqa: E402
from ledger_helpers import NOW, LedgerCase  # noqa: E402
from test_ledger_homes import CONV  # noqa: E402
from ledger import record  # noqa: E402

NOW_EPOCH = calendar.timegm(time.strptime(NOW, "%Y-%m-%dT%H:%M:%SZ"))
FOLDER = "/tmp/made-up/josh_360"


def no_git(folder, args):
    return None


class Killed(BaseException):
    """Stands in for the job runner's kill at the timeout: nothing after it runs, not even `finally` saves."""


class Budget(LedgerCase):
    def setUp(self):
        super().setUp()
        self.spool = self.tmp / "spool"
        self.projects = self.tmp / "projects"
        self.state = {"spool": {"file": "", "offset": 0}, "sessions": {}}
        self.clock = [0.0]
        self.reads = []
        self.saved = None

    def quiet(self, sid, ticket):
        path = self.projects / "-made-up" / (sid + ".jsonl")
        tr.write(path, tr.plain(FOLDER, session_id=sid, branch="{}-made-up".format(ticket)), mtime=NOW_EPOCH - 3600)
        return path

    def jira(self, seconds=0.0, kill_on=None):
        """A Jira that takes `seconds` of the made-up clock per read, and kills the run when asked for `kill_on`."""
        def read(key):
            if key == kill_on:
                raise Killed()
            self.reads.append(key)
            self.clock[0] += seconds
            return {"epic_key": "JP-901", "initiative_key": None, "area": None, "system": None}
        return read

    def save(self, state):
        self.saved = copy.deepcopy(state)

    def go(self, jira, budget=150.0, state=None):
        state = self.state if state is None else state
        return record.run(self.conn, state, now=NOW, spool=self.spool, projects=self.projects, git=no_git, jira=jira,
                          conventions=CONV, budget=budget, clock=lambda: self.clock[0], save=self.save)

    def episodes(self):
        return self.rows("SELECT s.tool_session_id, e.episode FROM session_episodes e "
                         "JOIN sessions s ON s.session_uid = e.session_uid ORDER BY 1, 2")

    def test_jira_is_read_once_per_ticket_in_a_run(self):
        for n in range(6):
            self.quiet("sess-{:04d}".format(n), "JP-90{}".format(n % 2))
        self.go(self.jira())
        self.assertEqual(len(self.episodes()), 6)
        self.assertEqual(sorted(self.reads), ["JP-900", "JP-901"])
        self.assertEqual(self.state["rehomed"], NOW[:10])

    def test_a_failed_jira_read_is_not_repeated_in_the_same_run(self):
        for n in range(4):
            self.quiet("sess-{:04d}".format(n), "JP-900")
        calls = []
        self.go(lambda key: calls.append(key))
        self.assertEqual(calls, ["JP-900"])
        self.assertEqual(self.rows("SELECT DISTINCT jira_read FROM current_homes"), [("failed",)])

    def test_a_run_stops_at_its_budget_and_the_next_run_carries_on(self):
        for n in range(6):
            self.quiet("sess-{:04d}".format(n), "JP-90{}".format(n))  # six tickets: every read costs ten seconds
        counts = self.go(self.jira(seconds=10.0), budget=25.0)
        self.assertTrue(counts["deferred"])
        first = len(self.episodes())
        self.assertGreater(first, 0)
        self.assertLess(first, 6)
        self.assertNotEqual(self.state.get("rehomed"), NOW[:10])
        for _ in range(10):
            self.clock[0] = 0.0
            counts = self.go(self.jira(seconds=10.0), budget=25.0)
            if not counts["deferred"]:
                break
        self.assertFalse(counts["deferred"])
        self.assertEqual(len(self.episodes()), 6)
        self.assertEqual(self.state["rehomed"], NOW[:10])
        self.assertEqual(self.count("session_homes"), 6)

    def test_the_daily_rehome_resumes_where_it_stopped(self):
        for n in range(6):
            self.quiet("sess-{:04d}".format(n), "JP-90{}".format(n))
        self.go(self.jira(), budget=1000.0)  # recorded, and today's re-home done
        self.state["rehomed"] = "2026-11-16"  # a new day: every session is due a fresh Jira read
        self.reads.clear()
        self.clock[0] = 0.0
        counts = self.go(self.jira(seconds=10.0), budget=25.0)
        self.assertTrue(counts["deferred"])
        self.assertNotEqual(self.state["rehomed"], NOW[:10])
        first = list(self.reads)
        self.assertLess(len(first), 6)
        self.reads.clear()
        for _ in range(10):
            self.clock[0] = 0.0
            if not self.go(self.jira(seconds=10.0), budget=25.0)["deferred"]:
                break
        self.assertEqual(self.state["rehomed"], NOW[:10])
        self.assertEqual(sorted(first + self.reads), ["JP-90{}".format(n) for n in range(6)],
                         "each session re-homed once across the runs, none read twice")

    def test_progress_is_saved_as_it_goes(self):
        """A run killed part-way (the runner's timeout) keeps what it recorded, and the next run does not record the
        same stretch of a resumed session again."""
        resumed = self.quiet("sess-0001", "JP-900")
        self.go(self.jira())
        self.assertEqual(self.episodes(), [("sess-0001", 1)])
        tr.append(resumed, [tr.line("user", "2026-11-17T11:00:00Z", "sess-0001", cwd=FOLDER,
                                    gitBranch="JP-900-made-up")], mtime=NOW_EPOCH - 3600)
        self.quiet("sess-0002", "JP-901")
        before_kill = copy.deepcopy(self.state)
        self.saved = None
        with self.assertRaises(Killed):
            self.go(self.jira(kill_on="JP-901"), state=before_kill)
        self.assertEqual(self.episodes(), [("sess-0001", 1), ("sess-0001", 2)])
        self.assertIsNotNone(self.saved, "nothing was saved before the kill")
        self.go(self.jira(), state=self.saved)
        self.assertEqual(self.episodes(), [("sess-0001", 1), ("sess-0001", 2), ("sess-0002", 1)])


if __name__ == "__main__":
    unittest.main()
