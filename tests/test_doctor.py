"""JP-152: the platform doctor. Each scenario from the ticket is a test here, on a made-up laptop (doctor_helpers.py)."""
import contextlib
import io
import json
import os
import sqlite3
import stat
import subprocess
import unittest

import doctor_helpers as h  # noqa: I001  (first: it puts scripts/ on the path)
from helpers import LaptopCase
import doctor  # noqa: E402
from doctor_lib import core, manual


def run_cli(case, *argv, ctx=None):
    """doctor.main in this process; returns (exit code, stdout)."""
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        code = doctor.main(list(argv), ctx or case.ctx())
    return code, out.getvalue()


class HealthyLaptop(h.DoctorCase):
    def test_a_healthy_laptop_passes(self):
        """Scenario: A healthy laptop passes."""
        code, text = run_cli(self, "--no-manual")
        self.assertEqual(code, 0, text)
        bad = [r for r in core.run_checks(self.ctx()) if r.status in ("fail", "warn")]
        self.assertEqual([(r.id, r.detail) for r in bad], [])
        self.assertIn("0 fail", text)

    def test_every_group_the_ticket_names_is_checked(self):
        groups = {r.group for r in core.run_checks(self.ctx())}
        self.assertTrue({"install", "jobs", "backfills", "hooks", "data", "evidence", "services", "accounts", "graphs",
                         "owed"} <= groups)

    def test_every_job_in_jobs_yaml_has_its_own_line(self):
        ids = set(self.results())
        for job in core.common.load_jobs(self.copy):
            if job["id"] in ("follow", "doctor"):  # follow has install.follow-ran; the doctor job is this report
                continue
            self.assertIn(("backfills." if job["every"] is None else "jobs.") + job["id"], ids)


class AgentOutput(h.DoctorCase):
    def test_json_has_status_fix_and_name_for_every_check(self):
        """Scenario: An agent can read the result."""
        (self.user / ".claude" / "settings.json").unlink()
        code, text = run_cli(self, "--json")
        data = json.loads(text)
        self.assertEqual(code, 1)
        self.assertFalse(data["ok"])
        self.assertEqual(data["schema"], 1)
        for c in data["checks"]:
            self.assertTrue(c["id"] and c["group"] and c["detail"], c)
            self.assertIn(c["status"], ("pass", "warn", "fail", "skip"))
            self.assertIn("fix", c)
            if c["status"] == "fail":
                self.assertTrue(c["fix"], "a failing check names its fix step: " + c["id"])
        self.assertEqual(sum(data["summary"].values()), len(data["checks"]))
        self.assertTrue(data["manual"])

    def test_no_secret_reaches_the_output(self):
        self.write_settings([])  # settings that hold a secret, and checks that read them
        for argv in (["--json"], []):
            _, text = run_cli(self, *argv)
            for secret in (h.SECRET_TOKEN, h.SECRET_EMAIL, h.SECRET_IN_SETTINGS):
                self.assertNotIn(secret, text)

    def test_the_manual_list_covers_the_owed_proofs(self):
        tickets = {m["ticket"] for m in manual.MANUAL}
        self.assertTrue({"JP-105", "JP-109", "JP-110", "JP-111", "JP-118", "JP-121"} <= tickets)
        _, text = run_cli(self)
        self.assertIn("ONLY YOU CAN CHECK", text)
        _, text = run_cli(self, "--no-manual")
        self.assertNotIn("ONLY YOU CAN CHECK", text)

    def test_misuse_exits_2(self):
        for argv in (["--dry-run"], ["--jira-email", "a@b.co"], ["--only", "nonsense"]):
            with self.assertRaises(SystemExit) as caught, contextlib.redirect_stderr(io.StringIO()):
                doctor.main(argv, self.ctx())
            self.assertEqual(caught.exception.code, 2)

    def test_only_runs_one_group(self):
        _, text = run_cli(self, "--json", "--only", "hooks")
        self.assertEqual({c["group"] for c in json.loads(text)["checks"]}, {"hooks"})

    def test_strict_fails_on_a_warning(self):
        (self.home / "state" / "cache.db").unlink()
        self.assertEqual(run_cli(self)[0], 0)
        self.assertEqual(run_cli(self, "--strict")[0], 1)

    def test_a_crashing_check_fails_only_itself(self):
        def boom(ctx):
            raise RuntimeError("nope")
        core.REGISTRY.append(("install", "boom", boom))
        self.addCleanup(core.REGISTRY.pop)
        results = self.results()
        self.assertEqual(results["install.boom"].status, "fail")
        self.assertEqual(results["install.home"].status, "pass")


class MissingParts(h.DoctorCase):
    def test_a_hook_missing_from_settings_fails_with_one_fix(self):
        """Scenario: A missing part fails with one fix step."""
        self.write_settings([e for e in h.ALL_EVENTS if e != "PostToolUse"])
        r = self.results()
        self.assertEqual(r["hooks.dispatch-PostToolUse"].status, "fail")
        self.assertIn("add-josh-360-hooks.py", r["hooks.dispatch-PostToolUse"].fix)
        for name in ("hooks.atlas-guard", "hooks.ticket-comments", "hooks.graph-step"):
            self.assertEqual(r[name].status, "fail", name)
        self.assertEqual(r["hooks.dispatch-Stop"].status, "pass")
        code, text = run_cli(self)
        self.assertEqual(code, 1)
        self.assertIn("FAIL  hooks.dispatch-PostToolUse", text)
        self.assertIn("fix: ", text)

    def test_an_event_without_hook_files_is_only_a_warning(self):
        self.write_settings([e for e in h.ALL_EVENTS if e != "Notification"])
        self.assertEqual(self.results()["hooks.dispatch-Notification"].status, "warn")

    def test_a_dispatcher_entry_for_the_wrong_event_fails(self):
        data = json.loads((self.user / ".claude" / "settings.json").read_text())
        data["hooks"]["PreToolUse"][0]["hooks"][0]["command"] = data["hooks"]["PreToolUse"][0]["hooks"][0]["command"].replace(
            "PreToolUse", "Stop")
        (self.user / ".claude" / "settings.json").write_text(json.dumps(data))
        self.assertEqual(self.results()["hooks.dispatch-PreToolUse"].status, "fail")

    def test_a_non_executable_hook_fails(self):
        p = self.copy / "hooks" / "PreToolUse" / "30-ticket-offer"
        p.chmod(p.stat().st_mode & ~(stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH))
        r = self.results()
        self.assertEqual(r["hooks.ticket-offer"].status, "fail")
        self.assertEqual(r["hooks.files"].status, "fail")

    def test_old_atlas_hooks_left_in_settings_fail(self):
        data = json.loads((self.user / ".claude" / "settings.json").read_text())
        data["hooks"]["SessionStart"].append({"hooks": [{"type": "command", "command": "node ~/x/atlas-hook.js"}]})
        (self.user / ".claude" / "settings.json").write_text(json.dumps(data))
        self.assertEqual(self.results()["hooks.old-atlas"].status, "fail")

    def test_the_copy_behind_main_fails(self):
        h.git("-c", "user.name=t", "-c", "user.email=t@invalid", "commit", "-q", "--allow-empty", "-m", "newer", cwd=self.copy)
        newer = h.git("rev-parse", "HEAD", cwd=self.copy)
        h.git("update-ref", "refs/remotes/origin/main", newer, cwd=self.copy)
        h.git("checkout", "-q", "--detach", self.sha, cwd=self.copy)
        r = self.results()["install.follows-main"]
        self.assertEqual(r.status, "fail")
        self.assertIn("1 commit(s) behind", r.detail)

    def test_local_changes_in_the_copy_fail(self):
        (self.copy / "jobs.yaml").write_text((self.copy / "jobs.yaml").read_text() + "# edit\n")
        self.assertEqual(self.results()["install.follows-main"].status, "fail")

    def test_an_install_record_that_does_not_match_fails(self):
        (self.home / "state" / "installed.json").write_text(json.dumps({"commit": "0" * 40}))
        r = self.results()["install.installed-commit"]
        self.assertEqual((r.status, r.fix_key), ("fail", "install"))

    def test_paused_fails(self):
        (self.home / "PAUSED").write_text("")
        self.assertEqual(self.results()["install.not-paused"].status, "fail")

    def test_a_runner_that_is_not_loaded_fails(self):
        self.loaded.discard(core.JOBS_RUNNER_LABEL)
        self.assertEqual(self.results()["install.runner-launchd"].status, "fail")

    def test_a_stale_follow_job_warns_and_a_failed_one_fails(self):
        path = self.home / "state" / "jobs-state.json"
        state = json.loads(path.read_text())
        state["follow"]["last_run"] = h.NOW.timestamp() - 7200
        path.write_text(json.dumps(state))
        self.assertEqual(self.results()["install.follow-ran"].status, "warn")
        state["follow"]["last_result"] = 1
        path.write_text(json.dumps(state))
        self.assertEqual(self.results()["install.follow-ran"].status, "fail")

    def test_a_failing_recurring_job_fails_and_an_overdue_one_warns(self):
        path = self.home / "state" / "jobs-state.json"
        state = json.loads(path.read_text())
        state["ledger-record"]["last_result"] = 3
        state["ledger-backup"]["last_run"] = h.NOW.timestamp() - 10 * 86400
        path.write_text(json.dumps(state))
        r = self.results()
        self.assertEqual(r["jobs.ledger-record"].status, "fail")
        self.assertIn("ledger-record.log", r["jobs.ledger-record"].fix)
        self.assertEqual(r["jobs.ledger-backup"].status, "warn")

    def test_once_jobs_that_never_ran_or_wait_are_not_failures_but_failed_ones_are(self):
        path = self.home / "state" / "jobs-state.json"
        state = json.loads(path.read_text())
        del state["ledger-backfill"]
        state["retire-session-atlas"] = {"last_run": h.NOW.timestamp() - 600, "last_result": 1}
        state["ledger-friction-catchup"]["last_result"] = 1
        path.write_text(json.dumps(state))
        r = self.results()
        self.assertEqual(r["backfills.ledger-backfill"].status, "warn")
        self.assertEqual(r["backfills.retire-session-atlas"].status, "warn")
        self.assertIn("waiting for ledger-backfill", r["backfills.retire-session-atlas"].detail)
        self.assertEqual(r["backfills.ledger-friction-catchup"].status, "fail")

    def test_a_backfill_that_says_done_but_left_nothing_warns(self):
        import shutil
        shutil.rmtree(str(self.user / "Archive"))
        self.assertEqual(self.results()["backfills.retire-session-atlas"].status, "warn")


class Databases(h.DoctorCase):
    def test_a_missing_ledger_fails_and_is_fixable(self):
        os.unlink(str(self.home / "state" / "ledger.db"))
        r = self.results()["data.ledger"]
        self.assertEqual((r.status, r.fix_key), ("fail", "install"))
        self.assertFalse((self.home / "state" / "ledger.db").exists(), "the doctor never creates a ledger")

    def test_an_old_schema_version_fails(self):
        conn = sqlite3.connect(str(self.home / "state" / "ledger.db"))
        conn.execute("PRAGMA user_version = 0")
        conn.close()
        self.assertEqual(self.results()["data.ledger"].status, "fail")

    def test_a_ledger_missing_its_triggers_fails(self):
        conn = sqlite3.connect(str(self.home / "state" / "ledger.db"))
        conn.execute("DROP TRIGGER sessions_no_delete")
        conn.commit()
        conn.close()
        r = self.results()["data.ledger-shape"]
        self.assertEqual(r.status, "fail")
        self.assertIn("sessions_no_delete", r.detail)

    def test_a_corrupt_ledger_fails_cleanly(self):
        (self.home / "state" / "ledger.db").write_bytes(b"not a database" * 20)
        self.assertEqual(self.results()["data.ledger"].status, "fail")

    def test_recursive_triggers_must_be_turned_on_by_the_code(self):
        db_py = self.copy / "ledger" / "db.py"
        db_py.write_text(db_py.read_text().replace("PRAGMA recursive_triggers = ON", "PRAGMA foreign_keys = ON"))
        self.assertEqual(self.results()["data.recursive-triggers"].status, "fail")

    def test_cache_db_missing_warns_and_an_empty_one_fails(self):
        os.unlink(str(self.home / "state" / "cache.db"))
        self.assertEqual(self.results()["data.cache-db"].status, "warn")
        sqlite3.connect(str(self.home / "state" / "cache.db")).close()
        self.assertEqual(self.results()["data.cache-db"].status, "fail")

    def test_backups_missing_warn_and_stale_fail(self):
        backup = self.home / "backups" / "ledger-2026-11-17.db.gz"
        old = h.NOW.timestamp() - 5 * 86400
        os.utime(str(backup), (old, old))
        self.assertEqual(self.results()["data.backups"].status, "fail")
        backup.unlink()
        self.assertEqual(self.results()["data.backups"].status, "warn")

    def test_an_empty_ledger_warns_and_no_evidence_warns(self):
        conn = sqlite3.connect(str(self.home / "state" / "ledger.db"))
        conn.execute("PRAGMA recursive_triggers = ON")
        for table in ("ticket_offers", "comment_deliveries"):
            conn.execute("DROP TRIGGER {}_no_delete".format(table))
            conn.execute("DELETE FROM {}".format(table))
        conn.commit()
        conn.close()
        r = self.results()
        self.assertEqual(r["evidence.ticket-offer"].status, "warn")
        self.assertEqual(r["evidence.ticket-comments"].status, "warn")
        self.assertEqual(r["evidence.summaries"].status, "pass")


class ServicesAndAccounts(h.DoctorCase):
    def test_atlas_waits_until_the_old_one_is_retired(self):
        state = json.loads((self.home / "state" / "jobs-state.json").read_text())
        state["retire-session-atlas"]["last_result"] = 1
        (self.home / "state" / "jobs-state.json").write_text(json.dumps(state))
        r = self.results()
        self.assertEqual((r["services.atlas-launchd"].status, r["services.atlas-health"].status), ("skip", "skip"))

    def test_atlas_not_loaded_or_not_answering_fails(self):
        self.loaded.discard("com.josh360.session-atlas")
        self.health = 500
        r = self.results()
        self.assertEqual(r["services.atlas-launchd"].status, "fail")
        self.assertEqual(r["services.atlas-health"].status, "fail")

    def test_the_old_atlas_still_loaded_fails(self):
        self.loaded.add("com.eventus.claude-atlas")
        self.assertEqual(self.results()["services.old-atlas-gone"].status, "fail")

    def test_atlas_log_that_cannot_read_the_ledger_fails(self):
        (self.home / "atlas" / "atlas.log").write_text("warn ledger.db not readable; session mirror skipped this pass\n")
        self.assertEqual(self.results()["services.atlas-log"].status, "fail")

    def test_a_node_that_is_too_old_fails(self):
        (self.stubs / "node").write_text("#!/bin/sh\necho v20.1.0\n")
        r = self.results(runner=lambda argv, t: (0, "v20.1.0\n", "") if argv[0].endswith("node") else self.runner(argv, t))
        self.assertEqual(r["services.node"].status, "fail")

    def test_azure_not_configured_warns_and_does_not_demand_a_login(self):
        os.unlink(str(self.home / "state" / "azure-backup.json"))
        self.az_code = 1
        r = self.results()
        self.assertEqual(r["accounts.azure-config"].status, "warn")
        self.assertEqual(r["accounts.az-login"].status, "warn")
        self.assertEqual(r["accounts.azure-upload"].status, "skip")

    def test_azure_configured_but_signed_out_fails(self):
        self.az_code = 1
        r = self.results()
        self.assertEqual(r["accounts.az-login"].status, "fail")
        self.assertEqual(r["accounts.az-login"].fix, "az login")

    def test_a_secret_in_the_azure_settings_is_refused(self):
        (self.home / "state" / "azure-backup.json").write_text(json.dumps({"account": "madeupstorage", "container": "madeup-backups",
                                                                          "key": "x"}))
        self.assertEqual(self.results()["accounts.azure-config"].status, "fail")

    def test_azure_upload_age_and_pending_redactions(self):
        (self.home / "state" / "azure-upload.json").write_text(json.dumps({"last_success": "2026-11-01T06:00:00Z"}))
        self.assertEqual(self.results()["accounts.azure-upload"].status, "fail")
        (self.home / "state" / "azure-upload.json").write_text(json.dumps({"last_success": "2026-11-17T06:00:00Z"}))
        (self.home / "state" / "azure-redactions-pending.json").write_text("[]")
        self.assertEqual(self.results()["accounts.azure-upload"].status, "warn")

    def test_jira_email_and_token(self):
        os.unlink(str(self.home / "state" / "jira-email"))
        self.keychain_code = 44
        self.env.pop("JOSH360_JIRA_TOKEN")
        r = self.results()
        self.assertEqual((r["accounts.jira-email"].status, r["accounts.jira-email"].fix_key), ("fail", "jira-email"))
        self.assertEqual(r["accounts.jira-token"].status, "fail")

    def test_the_keychain_is_asked_about_never_read(self):
        self.env.pop("JOSH360_JIRA_TOKEN")
        self.results()
        asked = [c for c in self.calls if os.path.basename(c[0]) == "security"]
        self.assertTrue(asked)
        for c in asked:
            self.assertNotIn("-w", c)
            self.assertNotIn("-g", c)

    def test_claude_missing_warns(self):
        os.unlink(str(self.user / ".local" / "bin" / "claude"))
        self.env["PATH"] = str(self.stubs)
        self.assertEqual(self.results()["accounts.claude-cli"].status, "warn")

    def test_online_asks_jira_and_github_and_offline_does_not(self):
        self.assertNotIn("accounts.jira-live", self.results())
        self.assertFalse([c for c in self.calls if "ls-remote" in c])
        self.ls_remote = (0, "{}\trefs/heads/main\n{}\trefs/heads/laptop-pause\n".format("f" * 40, "e" * 40), "")
        r = self.results(online=True, jira_fetch=lambda path: {"accountId": "x"})
        self.assertEqual(r["accounts.jira-live"].status, "pass")
        self.assertEqual(r["install.remote-main"].status, "warn")
        self.assertEqual(r["install.pause-branch"].status, "fail")
        r = self.results(online=True, jira_fetch=lambda path: None)
        self.assertEqual(r["accounts.jira-live"].status, "fail")


class Graphs(h.DoctorCase):
    def test_a_changed_graph_source_makes_the_compiled_copy_stale(self):
        flows = sorted((self.copy / "graphs" / "flows").glob("*.yaml"))
        flows[0].write_text(flows[0].read_text() + "\n# changed\n")
        r = self.results()["graphs.compiled"]
        self.assertEqual(r.status, "fail")
        self.assertIn(flows[0].stem, r.detail)

    def test_a_missing_compiled_copy_fails(self):
        next(iter(sorted((self.copy / "graphs" / "compiled").glob("*.json")))).unlink()
        self.assertEqual(self.results()["graphs.compiled"].status, "fail")


class Owed(h.DoctorCase):
    def test_the_debrief_form_is_owed_from_1_december(self):
        import datetime
        later = h.NOW.replace(year=2026, month=12, day=2)
        self.assertEqual(self.results()["owed.debrief-form"].status, "skip")
        self.assertEqual(self.results(now=later)["owed.debrief-form"].status, "warn")


class ReadOnly(h.DoctorCase):
    def break_things(self):
        self.write_settings(["Stop"])
        os.unlink(str(self.home / "state" / "installed.json"))
        os.unlink(str(self.home / "state" / "jira-email"))
        (self.home / "PAUSED").write_text("")
        sqlite3.connect(str(self.home / "state" / "cache.db")).close()

    def test_the_doctor_changes_nothing_by_default(self):
        """Scenario: The doctor changes nothing by default."""
        self.break_things()
        before = h.snapshot(self.home, self.user)
        code, _ = run_cli(self)
        code2, _ = run_cli(self, "--json", "--online")
        self.assertEqual((code, code2), (1, 1))
        self.assertEqual(h.snapshot(self.home, self.user), before)

    def test_nothing_is_written_even_into_the_git_copy(self):
        self.break_things()
        before = h.snapshot(self.copy / ".git")
        run_cli(self)
        self.assertEqual(h.snapshot(self.copy / ".git"), before)

    def test_fix_dry_run_changes_nothing_and_says_what_it_would_do(self):
        self.break_things()
        before = h.snapshot(self.home, self.user)
        code, text = run_cli(self, "--fix", "--dry-run", "--jira-email", "me@example.com")
        self.assertEqual(h.snapshot(self.home, self.user), before)
        self.assertEqual(code, 1)
        self.assertIn("would-run", text)
        for key in ("install", "hooks", "jira-email"):
            self.assertIn(key, text)


class Fixes(h.DoctorCase):
    def test_fix_does_only_the_safe_reversible_things(self):
        """Scenario: --fix only does safe reversible things."""
        self.write_settings(["Stop"])
        os.unlink(str(self.home / "state" / "installed.json"))
        os.unlink(str(self.home / "state" / "azure-backup.json"))
        (self.home / "logs").rmdir()
        self.az_code = 1
        code, text = run_cli(self, "--json", "--fix")
        data = json.loads(text)
        done = {f["fix"]: f["outcome"] for f in data["fixes"]}
        self.assertEqual(done, {"install": "fixed", "hooks": "fixed"}, text)
        # what was put right
        self.assertTrue((self.home / "logs").is_dir())
        self.assertEqual(json.loads((self.home / "state" / "installed.json").read_text())["commit"], self.sha)
        self.assertTrue((self.user / ".claude" / "settings.json.bak-josh-360").is_file())
        status = {c["id"]: c["status"] for c in data["checks"]}
        self.assertEqual(status["hooks.dispatch-PostToolUse"], "pass")
        self.assertEqual(status["install.installed-commit"], "pass")
        # what it left alone: nothing it was not asked about, and the things only Josh can do
        self.assertEqual(status["accounts.azure-config"], "warn")
        self.assertEqual(status["accounts.az-login"], "warn")
        self.assertFalse((self.home / "state" / "azure-backup.json").exists())
        self.assertEqual(self.loaded, {core.JOBS_RUNNER_LABEL, "com.josh360.session-atlas"})
        self.assertEqual(code, 0)

    def test_fix_never_removes_a_pause_or_runs_an_install_while_paused(self):
        os.unlink(str(self.home / "state" / "installed.json"))
        (self.home / "PAUSED").write_text("")
        _, text = run_cli(self, "--json", "--fix")
        data = json.loads(text)
        self.assertTrue((self.home / "PAUSED").exists())
        self.assertFalse((self.home / "state" / "installed.json").exists())
        self.assertEqual([f["outcome"] for f in data["fixes"] if f["fix"] == "install"], ["skipped"])

    def test_fix_leaves_a_failing_unfixable_check_failing(self):
        os.unlink(str(self.home / "state" / "jira-email"))
        code, text = run_cli(self, "--json", "--fix")
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(text)["fixes"], [])

    def test_the_jira_email_is_written_only_when_given_and_valid(self):
        os.unlink(str(self.home / "state" / "jira-email"))
        _, text = run_cli(self, "--json", "--fix", "--jira-email", "not an address")
        self.assertEqual(json.loads(text)["fixes"][0]["outcome"], "skipped")
        self.assertFalse((self.home / "state" / "jira-email").exists())
        code, text = run_cli(self, "--json", "--fix", "--jira-email", h.SECRET_EMAIL)
        path = self.home / "state" / "jira-email"
        self.assertEqual(path.read_text().strip(), h.SECRET_EMAIL)
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertNotIn(h.SECRET_EMAIL, text)
        self.assertEqual(code, 0)
        # and it never overwrites one that is there
        _, text = run_cli(self, "--json", "--fix", "--jira-email", "other@example.com")
        self.assertEqual(path.read_text().strip(), h.SECRET_EMAIL)


class RealProcess(h.DoctorCase):
    def test_the_command_runs_as_a_script_with_exit_codes(self):
        env = dict(os.environ, JOSH360_HOME=str(self.home), HOME=str(self.user), PYTHONDONTWRITEBYTECODE="1",
                   JOSH360_NODE=str(self.stubs / "node"), JOSH360_AZ=str(self.stubs / "az"))
        script = str(self.copy / "scripts" / "doctor.py")
        done = subprocess.run([h.sys.executable, "-B", script, "--json"], env=env, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, universal_newlines=True)
        data = json.loads(done.stdout)
        self.assertEqual(done.returncode, 0 if data["ok"] else 1)
        self.assertTrue(data["checks"])
        self.assertEqual(data["laptop_copy"].count("repo"), 1)


class DoctorJob(LaptopCase):
    """The doctor runs daily as a job and its report comes back on laptop-status, so the cloud can read it."""

    def test_the_report_reaches_the_status_branch_even_when_checks_fail(self):
        result = self.laptop("run_jobs.py")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("reports/doctor.json", self.status_tree())
        report = json.loads(self.origin_git("show", "laptop-status:reports/doctor.json").stdout)
        self.assertEqual(report["schema"], 1)
        self.assertFalse(report["ok"], "the made-up laptop has no launchd job, so the report shows a failure")
        self.assertTrue(report["checks"])
        state = json.loads((self.j360 / "state" / "jobs-state.json").read_text())
        self.assertEqual(state["doctor"]["last_result"], 0)

    def test_the_cloud_reads_it_with_status_show(self):
        self.laptop("run_jobs.py", check=True)
        shown = self.laptop("status.py", "show", "doctor")
        self.assertEqual(shown.returncode, 0, shown.stderr)
        self.assertTrue(json.loads(shown.stdout)["checks"])
        self.assertEqual(self.laptop("status.py", "show", "no-such-job").returncode, 1)
        self.assertEqual(self.laptop("status.py", "show", "../x").returncode, 2)


if __name__ == "__main__":
    unittest.main()
