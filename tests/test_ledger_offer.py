"""JP-110: the one-line ticket offer. Made-up sessions, folders and tickets only; no network, no model."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ledger_helpers import NOW, ROOT, LedgerCase  # noqa: E402
from test_ledger_homes import CONV  # noqa: E402
from ledger import offer, record, spool  # noqa: E402

HOOK = ROOT / "hooks" / "PreToolUse" / "30-ticket-offer"
OFFER = ROOT / "ledger" / "offer.py"
STARTERS = ("JOSH360_RUN_ID", "ACTION_TRIAGE_TICKET_KEY", "ACTION_TRIAGE_ALLOW_ATLASSIAN_WRITES", "DESK_WORKER",
            "AGENT_MANAGER_SESSION_ID")
ONE_LINE = "This has become ticket-sized work, want me to open a ticket?"


def bash(command, sid="sess-0001", cwd="/tmp/made-up"):
    return {"session_id": sid, "cwd": cwd, "hook_event_name": "PreToolUse", "tool_name": "Bash",
            "tool_input": {"command": command}}


class Recognising(unittest.TestCase):
    """Which commands are "the first commit" and "a new branch"."""

    def kinds(self, command):
        return [(t.kind, t.branch) for t in offer.triggers(command)]

    def test_commits(self):
        for command in ("git commit -m 'a b'", "git add -A && git commit -m x", "cd /tmp/x; git commit",
                        "FOO=1 git commit --amend --no-edit", "git -C /tmp/x commit -m x",
                        "git add . \n git commit -m y"):
            self.assertEqual(self.kinds(command), [("first-commit", None)], command)

    def test_new_branches(self):
        cases = {
            "git checkout -b feat/x": "feat/x",
            "git checkout -B feat/x origin/main": "feat/x",
            "git switch -c feat/x": "feat/x",
            "git switch --create feat/x": "feat/x",
            "git branch feat/x": "feat/x",
            "git branch --track feat/x origin/main": "feat/x",
            "git worktree add -b feat/x ../p origin/main": "feat/x",
            "git -C /tmp/x checkout -b feat/x": "feat/x",
        }
        for command, name in cases.items():
            self.assertEqual(self.kinds(command), [("first-branch", name)], command)

    def test_a_branch_comes_before_a_commit_in_one_command(self):
        self.assertEqual(self.kinds("git checkout -b feat/x && git commit -m x")[0], ("first-branch", "feat/x"))

    def test_everything_else_is_not_a_trigger(self):
        for command in ("", "ls -la", "git status", "git branch", "git branch -d feat/x", "git branch -D feat/x",
                        "git branch --list", "git branch -m old new", "git checkout main", "git switch main",
                        "git log --grep commit", "git push origin HEAD", "echo git commit", "git commit --dry-run",
                        "git worktree add ../p feat/x", "git worktree remove ../p", "git diff commit-notes",
                        "git 'unterminated", "python3 -c 'print(1)'"):
            self.assertEqual(self.kinds(command), [], command)

    def test_the_ticket_pattern_is_the_recorders(self):
        from ledger import homes
        self.assertEqual(offer.TICKET_BRANCH.pattern, homes.TICKET_BRANCH.pattern)

    def test_the_directory_after_dash_c_is_kept(self):
        trigger = offer.triggers("git -C /tmp/other commit -m x")[0]
        self.assertEqual(trigger.directory, "/tmp/other")


class HookCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="josh360-offer-"))
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        self.home = self.tmp / "home"
        self.env = {k: v for k, v in os.environ.items() if k not in STARTERS}
        self.env.update(JOSH360_HOME=str(self.home), PYTHONDONTWRITEBYTECODE="1", GIT_CONFIG_GLOBAL=os.devnull,
                        GIT_CONFIG_SYSTEM=os.devnull)
        self.repo = self.tmp / "repo"
        self.repo.mkdir()

    def git(self, *args):
        subprocess.run(["git"] + list(args), cwd=str(self.repo), env=self.env, check=True,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def make_repo(self, branch):
        self.git("init", "-q", "-b", branch)
        self.git("config", "user.email", "made-up@example.test")
        self.git("config", "user.name", "Made Up")
        (self.repo / "a.txt").write_text("one\n")
        self.git("add", "a.txt")
        self.git("commit", "-q", "-m", "start")

    def run_hook(self, payload, env=None, via_dispatch=False):
        args = [str(ROOT / "hooks" / "dispatch"), "PreToolUse"] if via_dispatch else [sys.executable, str(HOOK)]
        return subprocess.run(args, input=payload if isinstance(payload, str) else json.dumps(payload),
                              env=env or self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              universal_newlines=True)

    def commit_input(self, sid="sess-0001", command="git commit -m 'made up'"):
        return bash(command, sid=sid, cwd=str(self.repo))

    def offer_lines(self):
        folder = self.home / "state" / "ledger-spool"
        out = []
        for p in sorted(folder.glob("*.jsonl")) if folder.is_dir() else []:
            out += [json.loads(line) for line in p.read_text().splitlines()]
        return [line for line in out if line.get("event") == "TicketOffer"]

    def marker(self, sid="sess-0001"):
        return self.home / "state" / "ticket-offer" / "offered" / sid

    def answer_file(self, sid="sess-0001"):
        return self.home / "state" / "ticket-offer" / "answered" / sid

    def context(self, result):
        return json.loads(result.stdout)["hookSpecificOutput"]["additionalContext"]


class TheOffer(HookCase):
    def test_first_commit_with_no_ticket_offers_one_line_and_goes_ahead(self):
        self.make_repo("feature-x")
        result = self.run_hook(self.commit_input())
        self.assertEqual(result.returncode, 0, result.stderr)  # exit 0: the commit goes ahead
        out = json.loads(result.stdout)
        self.assertEqual(set(out), {"hookSpecificOutput"})
        self.assertEqual(out["hookSpecificOutput"]["hookEventName"], "PreToolUse")
        self.assertNotIn("permissionDecision", out["hookSpecificOutput"])  # never a deny or a hold
        text = out["hookSpecificOutput"]["additionalContext"]
        self.assertIn(ONE_LINE, text)
        self.assertIn("carry on", text)
        self.assertIn("--session sess-0001 accepted", text)
        self.assertIn("--session sess-0001 declined", text)
        self.assertIn("graphs/intake/submit.py --source session --ref sess-0001", text)
        self.assertIn(str(OFFER), text)
        lines = self.offer_lines()
        self.assertEqual([(x["offer_event"], x["offer_trigger"], x["session_id"]) for x in lines],
                         [("offered", "first-commit", "sess-0001")])
        self.assertTrue(self.marker().is_file())

    def test_offer_is_quiet_in_a_graph_session(self):
        self.make_repo("feature-x")
        folder = self.home / "state" / "graph-sessions"
        folder.mkdir(parents=True)
        (folder / "sess-0001.json").write_text("{}")          # JP-117: the runner's link for a step session
        result = self.run_hook(self.commit_input())
        self.assertEqual((result.returncode, result.stdout), (0, ""))
        self.assertEqual(self.offer_lines(), [])
        self.assertFalse(self.marker().exists())

    def test_a_new_branch_with_no_ticket_key_offers_too(self):
        self.make_repo("main")
        result = self.run_hook(self.commit_input(command="git checkout -b feature-y"))
        self.assertIn(ONE_LINE, self.context(result))
        self.assertEqual(self.offer_lines()[0]["offer_trigger"], "first-branch")

    def test_the_offer_is_made_once(self):
        self.make_repo("feature-x")
        self.run_hook(self.commit_input())
        for command in ("git commit -m again", "git checkout -b another", "git commit --amend --no-edit"):
            again = self.run_hook(self.commit_input(command=command))
            self.assertEqual((again.returncode, again.stdout), (0, ""), command)
        self.assertEqual(len(self.offer_lines()), 1)

    def test_another_session_is_offered_on_its_own(self):
        self.make_repo("feature-x")
        self.run_hook(self.commit_input(sid="sess-0001"))
        second = self.run_hook(self.commit_input(sid="sess-0002"))
        self.assertIn(ONE_LINE, self.context(second))
        self.assertEqual(len(self.offer_lines()), 2)

    def test_two_hooks_firing_together_offer_once(self):
        self.make_repo("feature-x")
        procs = [subprocess.Popen([sys.executable, str(HOOK)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, env=self.env, universal_newlines=True) for _ in range(4)]
        outs = [p.communicate(json.dumps(self.commit_input()))[0] for p in procs]
        self.assertEqual(sum(1 for o in outs if o.strip()), 1)
        self.assertEqual(len(self.offer_lines()), 1)

    def test_it_runs_under_dispatch(self):
        self.make_repo("feature-x")
        result = self.run_hook(self.commit_input(), via_dispatch=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(ONE_LINE, self.context(result))


class NoOffer(HookCase):
    def silent(self, result):
        self.assertEqual((result.returncode, result.stdout), (0, ""), result.stderr)
        self.assertEqual(self.offer_lines(), [])
        self.assertFalse(self.marker().exists())

    def test_a_branch_named_after_a_ticket_key(self):
        for branch in ("JP-900/sample-work", "JP-900-sample-work", "AD-12"):
            shutil.rmtree(str(self.repo), True)
            self.repo.mkdir()
            self.make_repo(branch)
            self.silent(self.run_hook(self.commit_input()))

    def test_creating_a_branch_named_after_a_ticket_key(self):
        self.make_repo("main")
        self.silent(self.run_hook(self.commit_input(command="git checkout -b JP-900/sample-work")))
        self.silent(self.run_hook(self.commit_input(command="git worktree add -b JP-901-x ../w")))

    def test_a_question_only_session_makes_no_offer(self):
        self.make_repo("feature-x")
        for command in ("ls -la", "git status", "git log --oneline", "cat README.md", "git diff", "git branch -d old"):
            self.silent(self.run_hook(self.commit_input(command=command)))
        for tool in ("Read", "Edit", "Write", "WebFetch"):
            payload = dict(self.commit_input(), tool_name=tool)
            self.silent(self.run_hook(payload))
        self.assertFalse((self.home / "state").exists())  # nothing was even created

    def test_sessions_started_with_a_ticket_have_one(self):
        self.make_repo("feature-x")
        for name in ("JOSH360_RUN_ID", "ACTION_TRIAGE_TICKET_KEY", "ACTION_TRIAGE_ALLOW_ATLASSIAN_WRITES"):
            self.silent(self.run_hook(self.commit_input(), env=dict(self.env, **{name: "x"})))
        self.silent(self.run_hook(self.commit_input(), env=dict(self.env, DESK_WORKER="1")))

    def test_bad_input_exits_0_and_says_nothing(self):
        for bad in ("not json", "{}", "", json.dumps(["x"]), json.dumps({"session_id": "../x", "tool_name": "Bash",
                                                                          "tool_input": {"command": "git commit"}}),
                    json.dumps({"session_id": "s", "tool_name": "Bash", "tool_input": "git commit"}),
                    json.dumps({"session_id": "s", "tool_name": "Bash", "tool_input": {"command": 5}})):
            result = self.run_hook(bad)
            self.assertEqual((result.returncode, result.stdout), (0, ""), bad)

    def test_a_folder_that_is_not_a_repo_still_offers_when_creating_a_branch(self):
        payload = bash("git checkout -b feature-z", cwd=str(self.tmp))
        self.assertIn(ONE_LINE, self.context(self.run_hook(payload)))

    def test_a_commit_where_the_branch_cannot_be_read_does_not_offer_nor_fail(self):
        # not a repo, and `git commit` would fail anyway: nothing is claimed about the branch
        self.silent(self.run_hook(bash("git commit -m x", cwd=str(self.tmp))))

    def test_a_state_folder_that_cannot_be_written_does_not_offer_and_logs(self):
        self.make_repo("feature-x")
        self.home.mkdir(parents=True)
        (self.home / "state").write_text("a file where the folder should be")
        result = self.run_hook(self.commit_input())
        self.assertEqual((result.returncode, result.stdout), (0, ""))
        self.assertIn("ticket-offer failed", (self.home / "logs" / "hooks.log").read_text())
        self.assertNotIn("sess-0001", (self.home / "logs" / "hooks.log").read_text())


class WithTheLedger(LedgerCase):
    """A session the ledger already ties to a ticket is not offered one."""

    def setUp(self):
        super().setUp()
        self.env = {k: v for k, v in os.environ.items() if k not in STARTERS}
        self.env.update(JOSH360_HOME=str(self.tmp / "home"), PYTHONDONTWRITEBYTECODE="1", GIT_CONFIG_GLOBAL=os.devnull,
                        GIT_CONFIG_SYSTEM=os.devnull)
        self.repo = self.tmp / "repo"
        self.repo.mkdir()
        subprocess.run(["git", "init", "-q", "-b", "feature-x"], cwd=str(self.repo), env=self.env, check=True)

    def hook(self):
        return subprocess.run([sys.executable, str(HOOK)], input=json.dumps(bash("git commit -m x", cwd=str(self.repo))),
                              env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)

    def link(self, uid, source, relation="touched"):
        self.conn.execute(
            "INSERT INTO ticket_links (session_uid, tracker, ticket_key, relation, source, linked_at, recorded_by) "
            "VALUES (?, 'jira', 'JP-900', ?, ?, ?, 'test')", (uid, relation, source, NOW))

    def test_each_trusted_source_counts(self):
        for source in ("jira-command", "daemon", "walker", "josh", "offer", "backfill"):
            with self.subTest(source=source):
                sid = "sess-" + source
                self.link(self.session(sid), source)
                payload = bash("git commit -m x", sid=sid, cwd=str(self.repo))
                result = subprocess.run([sys.executable, str(HOOK)], input=json.dumps(payload), env=self.env,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
                self.assertEqual((result.returncode, result.stdout), (0, ""))

    def test_a_withdrawn_link_does_not_count(self):
        uid = self.session("sess-0001")
        self.link(uid, "jira-command")
        link_id = self.rows("SELECT id FROM ticket_links")[0][0]
        self.conn.execute("INSERT INTO corrections (table_name, row_id, reason, corrected_at, corrected_by, "
                          "recorded_by) VALUES ('ticket_links', ?, 'wrong', ?, 'josh', 'test')", (link_id, NOW))
        self.assertIn(ONE_LINE, json.loads(self.hook().stdout)["hookSpecificOutput"]["additionalContext"])

    def test_a_session_with_no_link_is_offered(self):
        self.session("sess-0001")
        self.assertIn(ONE_LINE, json.loads(self.hook().stdout)["hookSpecificOutput"]["additionalContext"])

    def test_the_hook_does_not_write_the_database(self):
        self.session("sess-0001")
        before = self.conn.execute("PRAGMA data_version").fetchone()[0]
        counts = {t: self.count(t) for t in ("sessions", "ticket_links", "ticket_offers")}
        self.hook()
        self.assertEqual(counts, {t: self.count(t) for t in counts})
        self.assertEqual(before, self.conn.execute("PRAGMA data_version").fetchone()[0])


class Answering(HookCase):
    def answer(self, *args, sid="sess-0001"):
        return subprocess.run([sys.executable, str(OFFER), "--session", sid] + list(args), env=self.env,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)

    def offered(self):
        self.make_repo("feature-x")
        self.run_hook(self.commit_input())

    def test_yes_is_spooled_with_the_ticket_key(self):
        self.offered()
        result = self.answer("accepted", "JP-901")
        self.assertEqual(result.returncode, 0, result.stderr)
        lines = self.offer_lines()
        self.assertEqual([(x["offer_event"], x["ticket_key"]) for x in lines], [("offered", None), ("accepted", "JP-901")])
        self.assertEqual(json.loads(self.answer_file().read_text()),
                         {"answer": "accepted", "ticket_key": "JP-901"})

    def test_no_is_spooled(self):
        self.offered()
        self.assertEqual(self.answer("declined").returncode, 0)
        self.assertEqual([x["offer_event"] for x in self.offer_lines()], ["offered", "declined"])

    def test_only_the_first_answer_counts(self):
        self.offered()
        self.answer("declined")
        again = self.answer("accepted", "JP-901")
        self.assertEqual(again.returncode, 0)
        self.assertIn("already", again.stdout)
        self.assertEqual([x["offer_event"] for x in self.offer_lines()], ["offered", "declined"])

    def test_an_answer_needs_an_open_offer(self):
        result = self.answer("declined")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.offer_lines(), [])
        self.assertFalse((self.home / "state" / "ticket-offer").exists())

    def test_a_bad_key_or_session_is_refused_and_nothing_is_written(self):
        self.offered()
        for args, sid in ((("accepted",), "sess-0001"), (("accepted", "jp-901"), "sess-0001"),
                          (("accepted", "JP-901; rm"), "sess-0001"), (("declined", "JP-901"), "sess-0001"),
                          (("maybe",), "sess-0001"), (("declined",), "../x")):
            self.assertEqual(self.answer(*args, sid=sid).returncode, 2, (args, sid))
        self.assertEqual([x["offer_event"] for x in self.offer_lines()], ["offered"])


class Recording(LedgerCase):
    """The recorder turns TicketOffer spool lines into ticket_offers rows, and a yes into a ticket link."""

    def setUp(self):
        super().setUp()
        self.spool = self.tmp / "spool"
        self.state = {"spool": {"file": "", "offset": 0}, "sessions": {}}

    def put(self, event, at, key=None, trigger=None, sid="sess-0001"):
        offer.append_line(self.spool, {"session_id": sid, "offer_event": event, "offer_trigger": trigger,
                                       "ticket_key": key}, at)

    def run_pass(self, state=None):
        return record.record_pass(self.conn, now=NOW, spool=self.spool, projects=self.tmp / "projects",
                                  git=lambda folder, args: None, jira=lambda key: None, conventions=CONV,
                                  state=self.state if state is None else state)

    def test_offer_and_answer_become_rows(self):
        self.put("offered", "2026-11-17T10:00:00Z", trigger="first-commit")
        self.put("accepted", "2026-11-17T10:01:00Z", key="JP-901")
        counts = self.run_pass()
        self.assertEqual(counts["offers"], 2)
        uid = self.uid("sess-0001")
        self.assertEqual(self.rows("SELECT session_uid, event, offer_trigger, ticket_key, at, recorded_by "
                                   "FROM ticket_offers ORDER BY id"),
                         [(uid, "offered", "first-commit", None, "2026-11-17T10:00:00Z", "ledger/record.py"),
                          (uid, "accepted", None, "JP-901", "2026-11-17T10:01:00Z", "ledger/record.py")])
        self.assertEqual(self.rows("SELECT session_uid, tracker, ticket_key, relation, source, linked_at "
                                   "FROM ticket_links"),
                         [(uid, "jira", "JP-901", "touched", "offer", "2026-11-17T10:01:00Z")])
        self.assertEqual(self.count("sessions"), 1)  # the session has a row to point at

    def test_a_decline_writes_no_link(self):
        self.put("offered", "2026-11-17T10:00:00Z", trigger="first-branch")
        self.put("declined", "2026-11-17T10:02:00Z")
        self.run_pass()
        self.assertEqual([r[0] for r in self.rows("SELECT event FROM ticket_offers ORDER BY id")],
                         ["offered", "declined"])
        self.assertEqual(self.count("ticket_links"), 0)

    def test_an_unanswered_offer_stays_an_offer(self):
        self.put("offered", "2026-11-17T10:00:00Z", trigger="first-commit")
        self.run_pass()
        self.assertEqual([r[0] for r in self.rows("SELECT event FROM ticket_offers")], ["offered"])

    def test_a_key_outside_any_known_space_is_kept_as_the_answer_but_not_linked(self):
        self.put("offered", "2026-11-17T10:00:00Z", trigger="first-commit")
        self.put("accepted", "2026-11-17T10:01:00Z", key="ZZ-5")
        self.run_pass()
        self.assertEqual(self.count("ticket_offers"), 2)
        self.assertEqual(self.count("ticket_links"), 0)

    def test_reading_the_same_lines_twice_writes_nothing_twice(self):
        self.put("offered", "2026-11-17T10:00:00Z", trigger="first-commit")
        self.put("accepted", "2026-11-17T10:01:00Z", key="JP-901")
        self.run_pass()
        again = self.run_pass(state={"spool": {"file": "", "offset": 0}, "sessions": {}})  # the mark was lost
        self.assertEqual(again["offers"], 0)
        self.assertEqual((self.count("ticket_offers"), self.count("ticket_links")), (2, 1))

    def test_a_malformed_line_is_skipped_and_the_rest_are_written(self):
        self.put("offered", "2026-11-17T10:00:00Z", trigger="first-commit")
        offer.append_line(self.spool, {"session_id": "sess-0002", "offer_event": "bogus", "offer_trigger": None,
                                       "ticket_key": None}, "2026-11-17T10:00:30Z")
        offer.append_line(self.spool, {"session_id": "sess-0003", "offer_event": "accepted", "offer_trigger": None,
                                       "ticket_key": None}, "2026-11-17T10:00:40Z")
        self.put("declined", "2026-11-17T10:03:00Z")
        counts = self.run_pass()
        self.assertEqual((counts["offers"], counts["skipped"]), (2, 2))
        self.assertEqual(self.count("ticket_offers"), 2)

    def test_the_session_start_line_and_offer_lines_share_the_spool(self):
        spool.append("SessionStart", {"session_id": "sess-0001", "cwd": "/tmp/made-up", "source": "startup",
                                      "started_by": "josh"}, "2026-11-17T09:00:00Z", self.spool)
        self.put("offered", "2026-11-17T10:00:00Z", trigger="first-commit")
        counts = self.run_pass()
        self.assertEqual((counts["sessions"], counts["offers"]), (1, 1))
        self.assertEqual(self.rows("SELECT started_by FROM sessions"), [("josh",)])


if __name__ == "__main__":
    unittest.main()
