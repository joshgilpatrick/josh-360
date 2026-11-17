"""JP-107, Task 4: where a session belongs, and the Jira read. Made-up registry, tickets and folders only."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ledger_helpers import NOW, LedgerCase  # noqa: E402
from ledger import homes, jira_read  # noqa: E402

REGISTRY = {
    "version": 1, "fallback": {"jira_space": "JP", "priority": "unassigned"},
    "spaces": {"JP": "Josh Projects", "AD": "Apps Development", "TECH": "initiatives"},
    "systems": [
        {"name": "made-up-app", "folders": ["~/Dev/made-up-app"], "repositories": ["made-up-app"], "area": "Made-up area",
         "tracker": "jira", "jira_space": "AD", "priority": "madeup"},
        {"name": "made-up-personal", "folders": ["~/Dev/personal"], "repositories": [], "area": None,
         "tracker": "linear", "linear_team": "GIL", "priority": "unassigned"},
    ],
}
PRIORITIES = {"version": 1, "priorities": [
    {"id": "madeup", "covers": {"areas": ["Made-up area"], "initiatives": [], "epics": []}},
    {"id": "epicprio", "covers": {"areas": [], "initiatives": [], "epics": ["JP-901"]}},
    {"id": "initprio", "covers": {"areas": [], "initiatives": ["TECH-901"], "epics": []}},
]}
CONV = {"registry": REGISTRY, "priorities": PRIORITIES, "version": "abc1234", "home": "/Users/made-up"}


def episode(branch=None, folder="/tmp/somewhere", repo=None, number=1):
    return {"episode": number, "branch": branch, "folder": folder, "repo": repo}


def jira_ok(context):
    return lambda key: dict(context)


JIRA_DOWN = lambda key: None  # noqa: E731


class Home(LedgerCase):
    def setUp(self):
        super().setUp()
        self.uid = self.session()
        self.episode(self.uid)

    def home(self, ep, jira=None):
        return homes.find_home(self.uid, ep, self.conn, CONV, jira or jira_ok({}))

    def test_branch_gives_ticket_epic_and_priority(self):
        """JP-107 scenario 1."""
        row = self.home(episode("JP-900/sample"), jira_ok({"epic_key": "JP-901", "initiative_key": None,
                                                           "area": None, "system": None}))
        self.assertEqual((row["method"], row["ticket_key"], row["epic_key"], row["jira_read"], row["priority"],
                          row["tracker"]), ("branch", "JP-900", "JP-901", "ok", "epicprio", "jira"))
        self.assertEqual(row["conventions_version"], "abc1234")
        self.assertEqual(row["evidence"], "JP-900/sample")

    def test_priority_falls_back_epic_then_initiative_then_area(self):
        row = self.home(episode("JP-900/x"), jira_ok({"epic_key": "JP-999", "initiative_key": "TECH-901"}))
        self.assertEqual(row["priority"], "initprio")
        row = self.home(episode("JP-900/x"), jira_ok({"epic_key": "JP-999", "system": "made-up-app"}))
        self.assertEqual((row["priority"], row["area"], row["system"]), ("madeup", "Made-up area", "made-up-app"))
        row = self.home(episode("JP-900/x"), jira_ok({"epic_key": None}))
        self.assertEqual(row["priority"], "unassigned")

    def test_dash_branch_counts(self):
        row = self.home(episode("JP-900-sample"), jira_ok({"epic_key": "JP-901"}))
        self.assertEqual((row["method"], row["ticket_key"]), ("branch", "JP-900"))
        self.assertEqual(self.home(episode("JP-900"), jira_ok({}))["ticket_key"], "JP-900")

    def test_unknown_space_is_not_a_ticket(self):
        row = self.home(episode("XX-1/thing"))
        self.assertEqual(row["method"], "unassigned")
        self.assertIsNone(row["ticket_key"])

    def test_registry_folder_gives_system(self):
        row = self.home(episode("main", folder="/Users/made-up/Dev/made-up-app/src"))
        self.assertEqual((row["method"], row["system"], row["priority"], row["ticket_key"], row["jira_read"]),
                         ("registry", "made-up-app", "madeup", None, "not-needed"))
        self.assertIn("made-up-app", row["evidence"])

    def test_repo_is_used_when_the_folder_is_not_listed(self):
        row = self.home(episode(None, folder="/tmp/elsewhere", repo="owner/Made-Up-App"))
        self.assertEqual((row["method"], row["system"]), ("registry", "made-up-app"))

    def test_unknown_folder_is_unassigned_and_asks_nothing(self):
        """JP-107 scenario 2."""
        row = self.home(episode("main", folder="/tmp/nowhere"))
        self.assertEqual((row["method"], row["priority"], row["system"], row["ticket_key"]),
                         ("unassigned", "unassigned", None, None))
        self.assertEqual(self.count("asks"), 0)
        homes.write_home_if_changed(self.conn, row, NOW)
        self.assertEqual(self.count("asks"), 0)

    def test_jira_down_records_failed_not_unassigned(self):
        """Review Focus 4."""
        row = self.home(episode("JP-900/sample"), JIRA_DOWN)
        self.assertEqual((row["method"], row["ticket_key"], row["jira_read"], row["epic_key"]),
                         ("branch", "JP-900", "failed", None))

    def test_linear_key_is_personal(self):
        row = self.home(episode("GIL-12/x"), JIRA_DOWN)
        self.assertEqual((row["tracker"], row["ticket_key"], row["priority"], row["jira_read"], row["system"]),
                         ("linear", "GIL-12", "unassigned", "not-needed", "made-up-personal"))

    def test_run_ticket_beats_a_newer_link(self):
        self.conn.execute("""INSERT INTO graph_runs (run_id, machine_id, graph_id, graph_source, graph_version,
                             subject_kind, subject_ref, tracker, ticket_key, phi, runner, started_at, recorded_by)
                             VALUES ('run-1', ?, 'triage', 'graph-file', 'abc', 'ticket', 'JP-950', 'jira', 'JP-950', 0,
                             'cli', ?, 't')""", (self.machine, NOW))
        self.conn.execute("""INSERT INTO step_runs (run_id, step_id, step_kind, attempt, loop_count, session_uid,
                             started_at, recorded_by) VALUES ('run-1', 'gate', 'gate', 1, 0, ?, ?, 't')""", (self.uid, NOW))
        self.conn.execute("""INSERT INTO ticket_links (session_uid, tracker, ticket_key, relation, source, linked_at,
                             recorded_by) VALUES (?, 'jira', 'JP-960', 'touched', 'josh', '2026-11-18T00:00:00Z', 't')""",
                          (self.uid,))
        row = self.home(episode("main"), jira_ok({"epic_key": "JP-901"}))
        self.assertEqual((row["method"], row["ticket_key"]), ("ticket-link", "JP-950"))
        self.assertIn("run-1", row["evidence"])

    def test_newest_trusted_link_homes_the_session(self):
        for key, source, when in (("JP-951", "jira-command", "2026-11-17T10:00:00Z"),
                                  ("JP-952", "daemon", "2026-11-17T11:00:00Z")):
            self.conn.execute("""INSERT INTO ticket_links (session_uid, tracker, ticket_key, relation, source,
                                 linked_at, recorded_by) VALUES (?, 'jira', ?, 'touched', ?, ?, 't')""",
                              (self.uid, key, source, when))
        row = self.home(episode("main"), jira_ok({"epic_key": "JP-901"}))
        self.assertEqual((row["method"], row["ticket_key"]), ("ticket-link", "JP-952"))

    def test_read_only_jira_command_does_not_home(self):
        """Only links in the spec's list count: a branch-sourced link, a 'subject' link or a withdrawn one do not."""
        self.conn.execute("""INSERT INTO ticket_links (session_uid, tracker, ticket_key, relation, source, linked_at,
                             recorded_by) VALUES (?, 'jira', 'JP-953', 'touched', 'branch', ?, 't')""", (self.uid, NOW))
        self.conn.execute("""INSERT INTO ticket_links (session_uid, tracker, ticket_key, relation, source, linked_at,
                             recorded_by) VALUES (?, 'jira', 'JP-954', 'subject', 'josh', ?, 't')""", (self.uid, NOW))
        withdrawn = self.conn.execute("""INSERT INTO ticket_links (session_uid, tracker, ticket_key, relation, source,
                             linked_at, recorded_by) VALUES (?, 'jira', 'JP-955', 'touched', 'josh', ?, 't')""",
                                      (self.uid, NOW)).lastrowid
        self.conn.execute("""INSERT INTO corrections (table_name, row_id, reason, corrected_at, corrected_by, recorded_by)
                             VALUES ('ticket_links', ?, 'wrong', ?, 'josh', 't')""", (withdrawn, NOW))
        self.assertEqual(self.home(episode("main"))["method"], "unassigned")

    def test_branch_wins_over_links_and_registry(self):
        self.conn.execute("""INSERT INTO ticket_links (session_uid, tracker, ticket_key, relation, source, linked_at,
                             recorded_by) VALUES (?, 'jira', 'JP-960', 'touched', 'josh', ?, 't')""", (self.uid, NOW))
        row = self.home(episode("JP-900/x", folder="/Users/made-up/Dev/made-up-app"), jira_ok({}))
        self.assertEqual((row["method"], row["ticket_key"]), ("branch", "JP-900"))

    def test_home_has_no_patient_data_field(self):
        for ep in (episode("JP-900/x"), episode("main", folder="/Users/made-up/Dev/made-up-app"), episode(None)):
            self.assertNotIn("patient_data", self.home(ep))
        self.assertNotIn("patient_data", [r[1] for r in self.rows("PRAGMA table_info(session_homes)")])

    def test_evidence_is_cut_and_screened(self):
        row = self.home(episode("main", folder="/tmp/" + "d" * 400))
        self.assertLessEqual(len(row["evidence"]), 300)


class Writing(LedgerCase):
    def setUp(self):
        super().setUp()
        self.uid = self.session()
        self.episode(self.uid)
        self.episode(self.uid, episode=2)

    def row(self, ep=1, **kw):
        return homes.find_home(self.uid, episode("JP-900/x", number=ep), self.conn, CONV, kw.get("jira") or jira_ok(
            {"epic_key": "JP-901"}))

    def test_unchanged_home_is_not_written_again(self):
        self.assertTrue(homes.write_home_if_changed(self.conn, self.row(), NOW))
        self.assertFalse(homes.write_home_if_changed(self.conn, self.row(), "2026-11-17T13:00:00Z"))
        self.assertFalse(homes.write_home_if_changed(self.conn, self.row(ep=2), "2026-11-17T14:00:00Z"))
        self.assertEqual(self.count("session_homes"), 1)

    def test_a_moved_epic_is_a_new_row_and_the_newest_wins(self):
        homes.write_home_if_changed(self.conn, self.row(), NOW)
        moved = self.row(jira=jira_ok({"epic_key": "JP-902"}))
        self.assertTrue(homes.write_home_if_changed(self.conn, moved, "2026-11-17T15:00:00Z"))
        self.assertEqual(self.count("session_homes"), 2)
        self.assertEqual(self.rows("SELECT epic_key FROM current_homes"), [("JP-902",)])

    def test_failed_home_is_written_again_once_jira_answers(self):
        self.assertTrue(homes.write_home_if_changed(self.conn, self.row(jira=JIRA_DOWN), NOW))
        self.assertFalse(homes.write_home_if_changed(self.conn, self.row(jira=JIRA_DOWN), "2026-11-17T13:00:00Z"))
        self.assertTrue(homes.write_home_if_changed(self.conn, self.row(), "2026-11-17T14:00:00Z"))
        self.assertEqual(self.rows("SELECT jira_read, epic_key FROM current_homes"), [("ok", "JP-901")])

    def test_a_failed_read_never_replaces_a_known_home(self):
        homes.write_home_if_changed(self.conn, self.row(), NOW)
        self.assertFalse(homes.write_home_if_changed(self.conn, self.row(jira=JIRA_DOWN), "2026-11-17T13:00:00Z"))
        self.assertEqual(self.rows("SELECT epic_key FROM current_homes"), [("JP-901",)])

    def test_the_row_satisfies_the_schema_checks(self):
        for ep, jira in ((episode("JP-900/x"), jira_ok({})), (episode(None, folder="/tmp/x"), None),
                         (episode(None, folder="/Users/made-up/Dev/made-up-app"), None), (episode("GIL-1/x"), None)):
            row = homes.find_home(self.uid, dict(ep, episode=1), self.conn, CONV, jira or JIRA_DOWN)
            homes.write_home_if_changed(self.conn, row, "2026-11-17T1{}:00:00Z".format(self.count("session_homes")))


class KeepsWords(unittest.TestCase):
    def test_keeps_words(self):
        self.assertTrue(homes.keeps_words("/Users/made-up/Dev/josh_360"))
        self.assertTrue(homes.keeps_words(None))
        self.assertTrue(homes.keeps_words(""))
        self.assertFalse(homes.keeps_words("/Users/made-up/Dev/app/data/.phi/sample"))
        self.assertFalse(homes.keeps_words("/Users/made-up/.PHI"))
        self.assertTrue(homes.keeps_words("/Users/made-up/Dev/phi-notes"))
        self.assertTrue(homes.keeps_words("/Users/made-up/Dev/Delphi"))


class JiraRead(unittest.TestCase):
    ISSUES = {
        "JP-900": {"key": "JP-900", "names": {"customfield_1": "Repository"}, "fields": {
            "issuetype": {"name": "Story"}, "parent": {"key": "JP-901"}, "labels": ["josh-360"],
            "customfield_1": "owner/Made_Up_App"}},
        "JP-901": {"key": "JP-901", "names": {}, "fields": {"issuetype": {"name": "Epic"}, "issuelinks": [
            {"outwardIssue": {"key": "JP-777"}}, {"inwardIssue": {"key": "TECH-901"}}]}},
        "JP-902": {"key": "JP-902", "names": {}, "fields": {"issuetype": {"name": "Subtask"}, "parent": {"key": "JP-900"},
                                                          "labels": ["made-up-app"]}},
        "JP-903": {"key": "JP-903", "names": {}, "fields": {"issuetype": {"name": "Task"}, "labels": []}},
    }

    def fetch(self, path):
        self.calls.append(path)
        key = path.split("/issue/")[1].split("?")[0]
        return self.ISSUES.get(key)

    def setUp(self):
        self.calls = []

    def test_story_gets_epic_initiative_and_repository(self):
        self.assertEqual(jira_read.ticket_context("JP-900", self.fetch),
                         {"epic_key": "JP-901", "initiative_key": "TECH-901", "area": None, "system": "made-up-app"})

    def test_an_epic_is_its_own_epic(self):
        ctx = jira_read.ticket_context("JP-901", self.fetch)
        self.assertEqual((ctx["epic_key"], ctx["initiative_key"]), ("JP-901", "TECH-901"))

    def test_subtask_walks_up_to_the_epic_and_uses_a_system_label(self):
        ctx = jira_read.ticket_context("JP-902", self.fetch, system_names=["Made-Up-App"])
        self.assertEqual((ctx["epic_key"], ctx["system"]), ("JP-901", "made-up-app"))

    def test_ticket_with_no_epic_is_a_good_read(self):
        self.assertEqual(jira_read.ticket_context("JP-903", self.fetch),
                         {"epic_key": None, "initiative_key": None, "area": None, "system": None})

    def test_a_failed_read_is_none(self):
        self.assertIsNone(jira_read.ticket_context("JP-404", self.fetch))
        self.assertIsNone(jira_read.ticket_context("JP-900", lambda path: None))

    def test_a_parent_that_cannot_be_read_is_none_not_a_guess(self):
        issues = dict(self.ISSUES)
        del issues["JP-901"]
        self.assertIsNone(jira_read.ticket_context("JP-900", lambda path: issues.get(path.split("/issue/")[1].split("?")[0])))

    def test_no_credentials_means_no_read(self):
        self.assertIsNone(jira_read.credentials({}, run=lambda *a, **k: (_ for _ in ()).throw(OSError())))
        self.assertIsNone(jira_read.credentials({"JOSH360_JIRA_EMAIL": "a@example.invalid"},
                                                run=lambda *a, **k: (_ for _ in ()).throw(OSError())))

    def test_credentials_from_the_environment_never_touch_the_keychain(self):
        def boom(*a, **k):
            raise AssertionError("keychain read")
        env = {"JOSH360_JIRA_EMAIL": "a@example.invalid", "JOSH360_JIRA_TOKEN": "made-up-token"}
        self.assertEqual(jira_read.credentials(env, run=boom), ("a@example.invalid", "made-up-token"))

    def test_the_fetch_hides_failures_and_never_echoes_the_token(self):
        env = {"JOSH360_JIRA_EMAIL": "a@example.invalid", "JOSH360_JIRA_TOKEN": "made-up-token"}

        def failing(request, timeout=None):
            raise OSError("boom made-up-token")
        fetch = jira_read.make_fetch(env, urlopen=failing)
        self.assertIsNone(fetch("/rest/api/3/issue/JP-900"))


if __name__ == "__main__":
    unittest.main()
