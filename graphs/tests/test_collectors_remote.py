"""JP-166: the collectors that read the ledger, Jira and GitHub (ledger-runs, jira-count, github-runs), plus the two
read-only GitHub calls they use, and the rule that no reading carries text. Made-up data; nothing reaches a network.

Run: python3 -m unittest discover -s graphs/tests   (from the repository root)
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

GATES = Path(__file__).resolve().parent.parent / "gates"
sys.path.insert(0, str(GATES))
sys.path.insert(0, str(GATES.parent.parent))

from dev_helpers import FakeGitHub  # noqa: E402
from watch_helpers import FakeJiraReader  # noqa: E402

from lib.collectors import doctor, github_runs, jira_count, job, ledger_runs, reading, report  # noqa: E402
from lib.dev_github import GitHub, GitHubError  # noqa: E402
from ledger import db  # noqa: E402

NOW = datetime(2026, 11, 18, 12, 0, 0, tzinfo=timezone.utc)
SINCE = "2026-11-17T12:00:00Z"
TEXT = "Jane Doe, born 1 January 1970, 555-0100"


def deps_for(home: Path, jira=None, github=None):
    return SimpleNamespace(environ={"JOSH360_HOME": str(home)}, now=lambda: NOW, jira=jira or FakeJiraReader(),
                           github=lambda repo: github or FakeGitHub(repo=repo))


class Case(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.home = Path(tmp.name)
        (self.home / "state").mkdir()

    def nothing(self, module):
        return {"fields": {name: None for name in module.FIELDS}, "link": ""}


class LedgerRunsTest(Case):
    def make_ledger(self):
        path = self.home / "state" / "ledger.db"
        db.ensure(path, self.home / "backups", SINCE)
        conn = db.connect(path)
        self.addCleanup(conn.close)
        machine = db.machine_id(conn)
        n = [0]

        def run(graph, ended, score):
            n[0] += 1
            conn.execute(
                "INSERT INTO graph_runs (run_id, machine_id, graph_id, graph_source, graph_version, subject_kind, "
                "subject_ref, tracker, ticket_key, phi, runner, started_at, recorded_by) "
                "VALUES (?, ?, ?, 'graph-file', 'abc', 'ticket', ?, 'jira', ?, 0, 'cli', ?, 't')",
                ("run-{}".format(n[0]), machine, graph, "JP-9{:03d}".format(n[0]), "JP-9{:03d}".format(n[0]),
                 "2026-11-16T09:00:00Z"))
            conn.execute("INSERT INTO run_ends (run_id, end_name, score, ended_at, recorded_by) VALUES (?, 'finished', ?, ?, 't')",
                         ("run-{}".format(n[0]), score, ended))
        return run

    def test_ledger_runs_counts_ends_since_the_watch_began(self):
        run = self.make_ledger()
        run("non-development", "2026-11-17T13:00:00Z", "success")
        run("non-development", "2026-11-17T14:00:00Z", "success")
        run("non-development", "2026-11-18T01:00:00Z", "needs-josh")
        run("non-development", "2026-11-17T11:59:59Z", "success")    # ended before the watch began
        run("development", "2026-11-17T15:00:00Z", "success")        # another graph
        got = ledger_runs.read("non-development", SINCE, deps_for(self.home))
        self.assertEqual(got["fields"], {"events": 3, "success": 2, "neutral": 0, "needs_josh": 1})
        self.assertEqual(got["link"], "")

    def test_ledger_runs_with_no_runs_is_zero_not_unknown(self):
        self.make_ledger()
        got = ledger_runs.read("non-development", SINCE, deps_for(self.home))
        self.assertEqual(got["fields"], {"events": 0, "success": 0, "neutral": 0, "needs_josh": 0})

    def test_ledger_runs_unknown_without_a_ledger(self):
        self.assertEqual(ledger_runs.read("non-development", SINCE, deps_for(self.home)), self.nothing(ledger_runs))

    def test_ledger_runs_does_not_create_a_ledger(self):
        ledger_runs.read("non-development", SINCE, deps_for(self.home))
        self.assertFalse((self.home / "state" / "ledger.db").exists())

    def test_ledger_runs_unknown_for_a_file_that_is_not_a_ledger(self):
        (self.home / "state" / "ledger.db").write_text("not a database")
        self.assertEqual(ledger_runs.read("non-development", SINCE, deps_for(self.home)), self.nothing(ledger_runs))

    def test_ledger_runs_refuses_a_bad_argument(self):
        self.make_ledger()
        for bad in ("non-development\n", "x'; DROP TABLE graph_runs; --", "Non-Development", ""):
            self.assertEqual(ledger_runs.read(bad, SINCE, deps_for(self.home)), self.nothing(ledger_runs), bad)

    def test_ledger_runs_declares_that_it_counts_events(self):
        self.assertTrue(ledger_runs.COUNTS_EVENTS)
        self.assertEqual(set(ledger_runs.FIELDS), {"events", "success", "neutral", "needs_josh"})


class JiraCountTest(Case):
    JQL = 'project = JP AND labels = "validation-failure" AND created >= -7d'

    def test_jira_count_counts(self):
        jira = FakeJiraReader()
        jira.search_rows = [{"key": "JP-9001", "fields": {"summary": TEXT}}, {"key": "JP-9002"}]
        got = jira_count.read(self.JQL, SINCE, deps_for(self.home, jira=jira))
        self.assertEqual(got["fields"], {"count": 2, "events": 2})
        self.assertEqual(jira.calls, [("search", self.JQL, 201)])

    def test_jira_count_of_none_is_zero(self):
        self.assertEqual(jira_count.read(self.JQL, SINCE, deps_for(self.home))["fields"], {"count": 0, "events": 0})

    def test_jira_count_failed_search_is_unknown(self):
        jira = FakeJiraReader()
        jira.search_fails = True
        self.assertEqual(jira_count.read(self.JQL, SINCE, deps_for(self.home, jira=jira))["fields"],
                         {"count": None, "events": None})

    def test_jira_count_over_200_is_unknown(self):
        jira = FakeJiraReader()
        jira.search_rows = [{"key": "JP-{}".format(i)} for i in range(201)]
        self.assertEqual(jira_count.read(self.JQL, SINCE, deps_for(self.home, jira=jira))["fields"],
                         {"count": None, "events": None})
        jira.search_rows = jira.search_rows[:200]
        self.assertEqual(jira_count.read(self.JQL, SINCE, deps_for(self.home, jira=jira))["fields"]["count"], 200)

    def test_jira_count_link_is_the_search(self):
        got = jira_count.read(self.JQL, SINCE, deps_for(self.home))
        self.assertEqual(got["link"], "https://example.atlassian.net/issues/?jql=" + "project%20%3D%20JP%20AND%20labels"
                         "%20%3D%20%22validation-failure%22%20AND%20created%20%3E%3D%20-7d")

    def test_jira_count_refuses_a_multi_line_argument(self):
        jira = FakeJiraReader()
        for bad in ("project = JP\n", "project = JP\nAND x = 1", "", "x" * 501):
            self.assertEqual(jira_count.read(bad, SINCE, deps_for(self.home, jira=jira)), self.nothing(jira_count), bad)
        self.assertEqual(jira.calls, [])

    def test_jira_count_keeps_the_argument_as_text(self):
        jira = FakeJiraReader()
        weird = 'project = JP AND labels = "x; rm -rf" AND created >= -7d'
        jira_count.read(weird, SINCE, deps_for(self.home, jira=jira))
        self.assertEqual(jira.calls, [("search", weird, 201)])


class GithubRunsTest(Case):
    ARG = "joshgilpatrick/josh-360 test.yml"

    def runs(self, *conclusions):
        github = FakeGitHub(repo="joshgilpatrick/josh-360")
        github.run_rows = [{"conclusion": c, "created_at": "2026-11-18T0{}:00:00Z".format(9 - i)}
                           for i, c in enumerate(conclusions)]
        return github

    def test_github_runs_counts_success_and_failure_only(self):
        github = self.runs("success", "failure", "cancelled", "success")
        got = github_runs.read(self.ARG, SINCE, deps_for(self.home, github=github))
        self.assertEqual(got["fields"], {"events": 3, "failed": 1, "last": "success"})
        self.assertEqual(got["link"], "https://github.com/joshgilpatrick/josh-360/actions/workflows/test.yml")

    def test_github_runs_last_is_the_newest_counted_run(self):
        github = self.runs("cancelled", "failure", "success")
        self.assertEqual(github_runs.read(self.ARG, SINCE, deps_for(self.home, github=github))["fields"]["last"],
                         "failure")

    def test_github_runs_no_runs_yet(self):
        got = github_runs.read(self.ARG, SINCE, deps_for(self.home, github=self.runs()))
        self.assertEqual(got["fields"], {"events": 0, "failed": 0, "last": None})

    def test_github_runs_asks_for_the_default_branch_when_none_is_named(self):
        github = self.runs("success")
        github.default_branch_name = "claude/main-by-another-name"
        github_runs.read(self.ARG, SINCE, deps_for(self.home, github=github))
        self.assertIn(("default_branch",), github.calls)
        self.assertIn(("workflow_runs", "test.yml", "claude/main-by-another-name", SINCE), github.calls)

    def test_github_runs_uses_the_named_branch(self):
        github = self.runs("success")
        github_runs.read(self.ARG + " release/1.0", SINCE, deps_for(self.home, github=github))
        self.assertNotIn(("default_branch",), github.calls)
        self.assertIn(("workflow_runs", "test.yml", "release/1.0", SINCE), github.calls)

    def test_github_runs_error_is_unknown(self):
        for call in ("default_branch", "workflow_runs"):
            github = self.runs("success")
            github.fail_on = {call}
            self.assertEqual(github_runs.read(self.ARG, SINCE, deps_for(self.home, github=github)),
                             self.nothing(github_runs), call)

    def test_github_runs_refuses_bad_arguments(self):
        github = self.runs("success")
        for bad in (self.ARG + "\n", "joshgilpatrick/josh-360 test.txt", "../.. test.yml", "a/.. test.yml",
                    "joshgilpatrick josh-360 test.yml", "josh/Ünï test.yml", ""):
            self.assertEqual(github_runs.read(bad, SINCE, deps_for(self.home, github=github)),
                             self.nothing(github_runs), repr(bad))
        self.assertEqual(github.calls, [])

    def test_github_runs_declares_that_it_counts_events(self):
        self.assertTrue(github_runs.COUNTS_EVENTS)


class GithubCallsTest(unittest.TestCase):
    """The two read-only calls on the real GitHub class, with a runner that answers from a table."""

    def runner(self, answers):
        calls = []

        def run(argv, **kwargs):
            calls.append(argv)
            code, out = answers(argv)
            return subprocess.CompletedProcess(argv, code, stdout=out, stderr="" if code == 0 else "HTTP 404: Not Found")
        run.calls = calls
        return run

    def test_default_branch_reads_the_repository(self):
        run = self.runner(lambda argv: (0, json.dumps({"default_branch": "main", "name": TEXT})))
        self.assertEqual(GitHub("o/r", {}, runner=run).default_branch(), "main")
        self.assertEqual(run.calls[0][:3], ["gh", "api", "repos/o/r"])

    def test_default_branch_that_is_not_a_branch_name_is_an_error(self):
        for body in ("{}", "[]", json.dumps({"default_branch": 3}), "not json"):
            run = self.runner(lambda argv, b=body: (0, b))
            with self.assertRaises(GitHubError):
                GitHub("o/r", {}, runner=run).default_branch()

    def test_workflow_runs_asks_for_completed_runs_since(self):
        body = json.dumps({"workflow_runs": [{"conclusion": "success", "created_at": "2026-11-18T09:00:00Z", "name": TEXT},
                                              {"conclusion": "failure", "created_at": "2026-11-17T09:00:00Z"}]})
        run = self.runner(lambda argv: (0, body))
        rows = GitHub("o/r", {}, runner=run).workflow_runs("test.yml", "main", SINCE)
        self.assertEqual(rows, [{"conclusion": "success", "created_at": "2026-11-18T09:00:00Z"},
                                {"conclusion": "failure", "created_at": "2026-11-17T09:00:00Z"}])
        argv = " ".join(run.calls[0])
        self.assertIn("repos/o/r/actions/workflows/test.yml/runs", argv)
        self.assertIn("branch=main", argv)
        self.assertIn("status=completed", argv)
        self.assertIn("created=>=" + SINCE, argv)
        self.assertIn("per_page=100", argv)
        self.assertIn("GET", run.calls[0])

    def test_workflow_runs_newest_first_up_to_100(self):
        rows = [{"conclusion": "success", "created_at": "2026-11-18T{:02d}:{:02d}:00Z".format(i // 60, i % 60)}
                for i in range(100)]
        run = self.runner(lambda argv: (0, json.dumps({"total_count": 100, "workflow_runs": rows})))
        got = GitHub("o/r", {}, runner=run).workflow_runs("test.yml", "main", SINCE)
        self.assertEqual(len(got), 100)
        self.assertEqual(got[0]["created_at"], rows[-1]["created_at"])

    def test_workflow_runs_past_100_is_an_error_not_a_floor(self):
        rows = [{"conclusion": "success", "created_at": "2026-11-18T{:02d}:{:02d}:00Z".format(i // 60, i % 60)}
                for i in range(100)]
        run = self.runner(lambda argv: (0, json.dumps({"total_count": 130, "workflow_runs": rows})))
        with self.assertRaises(GitHubError):
            GitHub("o/r", {}, runner=run).workflow_runs("test.yml", "main", SINCE)

    def test_workflow_runs_failure_raises(self):
        run = self.runner(lambda argv: (1, ""))
        with self.assertRaises(GitHubError):
            GitHub("o/r", {}, runner=run).workflow_runs("test.yml", "main", SINCE)
        run = self.runner(lambda argv: (0, json.dumps({"workflow_runs": "none"})))
        with self.assertRaises(GitHubError):
            GitHub("o/r", {}, runner=run).workflow_runs("test.yml", "main", SINCE)


class EveryReaderTest(Case):
    """The spec's scenarios 'No reading carries text from the system it read' and 'A collector never raises'."""

    def test_no_reading_carries_text(self):
        state = self.home / "state"
        (state / "reports").mkdir()
        (state / "jobs-state.json").write_text(json.dumps({"sample-job": {"last_run": TEXT, "last_result": TEXT}}))
        (state / "reports" / "doctor.json").write_text(json.dumps({
            "time": NOW.strftime("%Y-%m-%dT%H:%M:%SZ"), "summary": {"fail": TEXT},
            "checks": [{"id": "backfills.sample-check", "status": TEXT, "detail": TEXT}]}))
        jira = FakeJiraReader()
        jira.search_rows = [{"key": TEXT, "fields": {"summary": TEXT, "status": {"name": TEXT}}}]
        github = FakeGitHub(repo="o/r")
        github.default_branch_name = TEXT
        github.run_rows = [{"conclusion": TEXT, "created_at": "2026-11-18T09:00:00Z"}]
        deps = deps_for(self.home, jira=jira, github=github)
        cases = [(job, "sample-job"), (report, "doctor summary.fail"), (doctor, "backfills.sample-check"),
                 (ledger_runs, "non-development"), (jira_count, "project = JP"), (github_runs, "o/r test.yml")]
        for module, argument in cases:
            got = module.read(argument, SINCE, deps)
            self.assertEqual(set(got["fields"]), set(module.FIELDS), module.__name__)
            for name, value in got["fields"].items():
                self.assertTrue(value is None or reading.fits(value, "value"), (module.__name__, name, value))
            self.assertNotIn("Jane", json.dumps(got), module.__name__)

    def test_no_reader_raises(self):
        class Broken:
            def __getattr__(self, name):
                raise RuntimeError("no " + name)
        deps = Broken()
        cases = [(job, "sample-job"), (report, "doctor summary.fail"), (doctor, "backfills.sample-check"),
                 (ledger_runs, "non-development"), (jira_count, "project = JP"), (github_runs, "o/r test.yml")]
        for module, argument in cases:
            self.assertEqual(module.read(argument, SINCE, deps), self.nothing(module), module.__name__)

    def test_each_reader_declares_its_four_names(self):
        for module in (job, report, doctor, ledger_runs, jira_count, github_runs):
            self.assertIsInstance(module.FIELDS, dict, module.__name__)
            self.assertIsInstance(module.COUNTS_EVENTS, bool, module.__name__)
            self.assertTrue(hasattr(module.ARGUMENT, "fullmatch"), module.__name__)
            self.assertTrue(callable(module.read), module.__name__)


if __name__ == "__main__":
    unittest.main()
