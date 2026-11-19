"""JP-109: the live readers return None, never a guess, when a system cannot be read."""
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from ledger.live import Live  # noqa: E402


def done_issue(category="done", name="Done", flagged=False):
    fields = {"status": {"name": name, "statusCategory": {"key": category}}}
    if flagged:
        fields["customfield_10021"] = [{"value": "Impediment"}]
    return {"fields": fields}


class Result:
    def __init__(self, stdout="", returncode=0):
        self.stdout, self.returncode = stdout, returncode


class LiveTickets(unittest.TestCase):
    def test_done_and_not_done(self):
        live = Live(fetch=lambda path: done_issue("done") if "JP-901" in path else done_issue("indeterminate", "In Progress"))
        self.assertEqual(live.ticket("JP-901"), {"status": "Done", "done": True, "flagged": False})
        self.assertEqual(live.ticket("JP-902"), {"status": "In Progress", "done": False, "flagged": False})

    def test_ticket_reads_the_flag(self):
        paths = []

        def fetch(path):
            paths.append(path)
            return done_issue("indeterminate", "Deployed", flagged="JP-902" in path)

        live = Live(fetch=fetch)
        self.assertEqual(live.ticket("JP-901"), {"status": "Deployed", "done": False, "flagged": False})
        self.assertEqual(live.ticket("JP-902"), {"status": "Deployed", "done": False, "flagged": True})
        self.assertTrue(all(p.endswith("?fields=status,customfield_10021") for p in paths), paths)

    def test_unreadable_ticket_is_unknown(self):
        self.assertIsNone(Live(fetch=lambda path: None).ticket("JP-901"))
        self.assertIsNone(Live(fetch=lambda path: {"fields": {}}).ticket("JP-901"))

    def test_no_credentials_is_unknown_and_asked_once(self):
        live = Live(use_jira=False)
        self.assertIsNone(live.ticket("JP-901"))

    def test_each_ticket_is_read_once(self):
        calls = []

        def fetch(path):
            calls.append(path)
            return done_issue()

        live = Live(fetch=fetch)
        live.ticket("JP-901")
        live.ticket("JP-901")
        self.assertEqual(len(calls), 1)


class LivePullRequests(unittest.TestCase):
    def test_states(self):
        for state in ("OPEN", "MERGED", "CLOSED"):
            live = Live(run=lambda *a, _s=state, **k: Result('{"state": "%s"}' % _s))
            self.assertEqual(live.pr("https://example.test/o/r/pull/1"), state)

    def test_gh_failure_missing_gh_and_garbage_are_unknown(self):
        def missing(*a, **k):
            raise FileNotFoundError("gh")

        def timeout(*a, **k):
            raise subprocess.TimeoutExpired("gh", 30)

        for run in (lambda *a, **k: Result("", 1), missing, timeout, lambda *a, **k: Result("not json"),
                    lambda *a, **k: Result('{"state": "WEIRD"}')):
            self.assertIsNone(Live(run=run).pr("https://example.test/o/r/pull/1"))


if __name__ == "__main__":
    unittest.main()
