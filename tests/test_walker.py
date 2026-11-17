"""JP-114: the walker walks a whole graph by being fed outcomes, and holds the convention's limits. Made-up data only."""
import json
import os
import sqlite3
import subprocess
import sys
import unittest
from pathlib import Path

from walker_helpers import ROOT, WalkerCase, db, questions


class WalkingAGraph(WalkerCase):
    def test_a_whole_run_follows_each_outcome_to_the_end(self):
        run = self.start()
        spec = self.tmp / "spec.md"
        spec.write_text("a made-up spec\n")
        first = self.do_role(run, "design", "ready", {"spec_path": str(spec)}, session="sess-0001", model="claude-sonnet-5-5")
        self.assertEqual((first["tier"], first["jira_status"], first["attempt"]), ("mid", "Design/Planning", 1))
        self.assertEqual(first["models"], [{"effort": "medium", "model": "sample-medium-model"}])
        parked = self.walker("next", "--run", run)               # lint_spec (a gate) ran inside this call
        self.assertEqual((parked["action"], parked["step"]), ("parked", "approve_spec"))
        self.answer_in_app(run, "approve_spec", "build")
        build = self.do_role(run, "build", "done")
        self.assertEqual((build["agent"], build["tier"], build["jira_status"]), ("sample-builder", "cheap", "In Progress"))
        self.do_role(run, "review", "pass")
        self.do_role(run, "publish", "opened", {"pr_url": "https://example.test/pr/1"})
        parked = self.walker("next", "--run", run)               # check_review, then to_validation (a gate), then ask
        self.assertEqual(parked["step"], "approve_note")
        self.answer_in_app(run, "approve_note", "post")
        self.do_role(run, "post_note", "posted")
        done = self.walker("next", "--run", run)
        self.assertEqual((done["action"], done["end"], done["score"]), ("done", "finished", "success"))
        self.assertEqual(self.walker("next", "--run", run), done)   # asking again changes nothing
        steps = [(r[0], r[1], r[5]) for r in self.step_rows(run)]
        self.assertEqual(steps[0], ("_entry", 1, "pass"))
        self.assertEqual([s[0] for s in steps if not s[0].startswith("_")], [
            "design", "lint_spec", "approve_spec", "build", "review", "check_review", "publish", "to_validation",
            "approve_note", "post_note"])
        self.assertEqual(steps[-1], ("_exit", 1, "pass"))
        statuses = [e["status"] for e in self.log() if e.get("gate") == "move-ticket"]
        self.assertEqual(statuses, ["Design/Planning", "In Progress", "Code Review", "Validation"])

    def test_the_ledger_has_the_scoring_fields_for_every_step(self):
        run = self.start()
        self.do_role(run, "design", "ready", {"spec_path": "spec-1"}, session="sess-0001", model="claude-sonnet-5-5")
        conn = db.connect(db.ledger_path())
        self.addCleanup(conn.close)
        row = conn.execute("SELECT step, outcome, loop_count, tier, ticket, graph_version, model, session "
                           "FROM step_ledger WHERE step = 'design'").fetchone()
        self.assertEqual(row[:5], ("design", "ready", 0, "mid", "JP-901"))
        self.assertTrue(row[5].startswith("sha256:"))
        self.assertEqual(row[6], "claude-sonnet-5-5")
        self.assertTrue(row[7].endswith(":claude-code:sess-0001"))
        started_by = conn.execute("SELECT started_by FROM sessions").fetchone()[0]
        self.assertEqual(started_by, "walker")
        link = conn.execute("SELECT relation, source FROM ticket_links WHERE run_id = ?", (run,)).fetchone()
        self.assertEqual(link, ("subject", "walker"))

    def test_a_run_survives_a_closed_terminal(self):
        run = self.start()
        self.do_role(run, "design", "ready", {"spec_path": "spec-1"})
        env = dict(os.environ)
        cmd = [sys.executable, str(ROOT / "graphs" / "tools" / "walker.py"), "--root", str(self.root), "next", "--run", run]
        first = subprocess.run(cmd, env=env, stdout=subprocess.PIPE, universal_newlines=True)
        second = subprocess.run(cmd, env=env, stdout=subprocess.PIPE, universal_newlines=True)
        self.assertEqual(first.returncode, 0, first.stdout)
        self.assertEqual(json.loads(first.stdout)["step"], "approve_spec")
        self.assertEqual(first.stdout, second.stdout)
        self.answer_in_app(run, "approve_spec", "build")
        again = json.loads(subprocess.run(cmd, env=env, stdout=subprocess.PIPE, universal_newlines=True).stdout)
        self.assertEqual((again["action"], again["step"]), ("run", "build"))

    def test_a_role_step_that_was_started_is_printed_again_until_it_is_recorded(self):
        run = self.start()
        a = self.walker("next", "--run", run)
        b = self.walker("next", "--run", run)
        self.assertEqual((a["step"], a["attempt"]), (b["step"], b["attempt"]))
        self.assertEqual(len([r for r in self.step_rows(run) if r[0] == "design"]), 1)

    def test_an_abandoned_step_starts_again_as_the_next_attempt(self):
        run = self.start()
        self.walker("next", "--run", run)
        self.walker("abandon", "--run", run)
        again = self.walker("next", "--run", run)
        self.assertEqual((again["step"], again["attempt"]), ("design", 2))
        self.assertEqual([(r[0], r[1], r[5]) for r in self.step_rows(run) if r[0] == "design"],
                         [("design", 1, "_abandoned"), ("design", 2, None)])

    def test_a_declared_outcome_and_declared_outputs_only(self):
        run = self.start()
        self.walker("next", "--run", run)
        bad = self.walker("record", "--run", run, "--step", "design", "--outcome", "great", code=2)
        self.assertIn("not an outcome", bad["error"])
        rf = self.tmp / "r.json"
        rf.write_text(json.dumps({"outcome": "ready", "outputs": {"nonsense": 1}}))
        bad = self.walker("record", "--run", run, "--step", "design", "--result-file", rf, code=2)
        self.assertIn("does not declare", bad["error"])
        bad = self.walker("record", "--run", run, "--step", "build", "--outcome", "done", code=2)
        self.assertIn("not the role step", bad["error"])

    def test_the_files_a_run_made_are_saved_with_it_outside_the_repository(self):
        run = self.start()
        spec = self.tmp / "work" / "spec.md"
        spec.parent.mkdir()
        spec.write_text("a made-up spec\n")
        self.walk_happy(run, str(spec))
        conn = db.connect(db.ledger_path())
        self.addCleanup(conn.close)
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM run_files").fetchone()[0], 0)   # not before the end
        self.assertEqual(self.walker("next", "--run", run)["action"], "done")
        kind, name, path, sha = conn.execute("SELECT kind, name, path, sha256 FROM run_files").fetchone()
        self.assertEqual((kind, name), ("spec", "spec_path"))
        self.assertTrue(path.startswith(str(self.tmp / "runs" / run / "saved")))
        self.assertEqual(Path(path).read_text(), "a made-up spec\n")
        self.assertEqual(len(sha), 64)
        spec.unlink()
        self.assertTrue(Path(path).is_file())      # the copy outlives the file it came from


class Limits(WalkerCase):
    def walk_to_review(self, run):
        self.do_role(run, "design", "ready", {"spec_path": "spec-1"})
        self.walker("next", "--run", run)
        self.answer_in_app(run, "approve_spec", "build")

    def test_a_loop_limit_ends_at_a_human_and_josh_s_yes_buys_one_more_round(self):
        self.plan({"check-review": ["rework", "rework", "clean"]})
        run = self.start()
        self.walk_to_review(run)
        self.do_role(run, "build", "done")
        self.do_role(run, "review", "defects", {"defects": ["x"]})
        self.do_role(run, "build", "done")                     # the first rework went back to build
        self.do_role(run, "review", "defects", {"defects": ["x"]})
        parked = self.walker("next", "--run", run)             # the second rework is past the loop's limit of 1
        self.assertEqual((parked["action"], parked["step"], parked["limit"]), ("parked", "decide_review", "loop"))
        self.answer_in_app(run, "decide_review", "retry")
        build = self.do_role(run, "build", "done")
        self.assertEqual((build["attempt"], build["allowed_by_josh"]), (3, False))
        review = self.do_role(run, "review", "pass")           # the third run of a gate-tier step: the cap is 2
        self.assertEqual((review["attempt"], review["allowed_by_josh"]), (3, True))
        rows = {(r[0], r[1]): r for r in self.step_rows(run)}
        self.assertEqual(rows[("review", 3)][4], 1)
        self.assertEqual(rows[("review", 2)][4], 0)

    def test_a_step_that_runs_again_is_told_what_the_later_steps_found(self):
        self.plan({"check-review": ["rework", "clean"]})
        run = self.start()
        self.walk_to_review(run)
        first = self.do_role(run, "build", "done")
        self.assertNotIn("so_far", first)                      # the first run has nothing to add
        self.do_role(run, "review", "defects", {"defects": ["missing test"]})
        again = self.do_role(run, "build", "done")
        self.assertEqual(again["attempt"], 2)
        self.assertEqual(again["so_far"]["defects"], ["missing test"])
        for name in again["inputs"]:                           # what the step already gets is not repeated
            self.assertNotIn(name, again["so_far"])

    def test_declining_at_the_limit_moves_on_without_the_extra_round(self):
        self.plan({"check-review": ["rework"]})
        run = self.start()
        self.walk_to_review(run)
        for step in ("build", "review", "build", "review"):
            self.do_role(run, step, "done" if step == "build" else "defects", None if step == "build" else {"defects": []})
        self.assertEqual(self.walker("next", "--run", run)["step"], "decide_review")
        self.answer_in_app(run, "decide_review", "stop")
        done = self.walker("next", "--run", run)
        self.assertEqual((done["action"], done["end"], done["score"]), ("done", "decide_review.stop", "needs-josh"))
        conn = db.connect(db.ledger_path())
        self.addCleanup(conn.close)
        self.assertEqual(conn.execute("SELECT end_name, score FROM run_ends WHERE run_id = ?", (run,)).fetchone(),
                         ("decide_review.stop", "needs-josh"))

    def test_the_run_cap_counts_every_loop_that_reaches_a_step_together(self):
        # design (mid, cap 3) is reached by two loops: lint_spec -> design and approve_spec -> design.
        self.plan({"lint-spec": ["incomplete", "pass", "incomplete"]})
        run = self.start()
        self.do_role(run, "design", "ready", {"spec_path": "spec-1"})   # run 1; lint says incomplete
        self.do_role(run, "design", "ready", {"spec_path": "spec-1"})   # run 2 (loop one, 1 of 2); lint passes
        self.assertEqual(self.walker("next", "--run", run)["step"], "approve_spec")
        self.answer_in_app(run, "approve_spec", "revise")
        self.do_role(run, "design", "ready", {"spec_path": "spec-1"})   # run 3 (loop two, 1 of 2); lint: incomplete
        # Neither loop is at its own limit, but a fourth run of design would pass the mid cap of 3.
        parked = self.walker("next", "--run", run)
        self.assertEqual((parked["step"], parked["limit"]), ("approve_spec", "cap"))
        self.answer_in_app(run, "approve_spec", "revise", attempt=2)
        fourth = self.walker("next", "--run", run)
        self.assertEqual((fourth["step"], fourth["attempt"], fourth["allowed_by_josh"]), ("design", 4, True))

    def test_declining_to_revise_at_the_cap_moves_on(self):
        self.plan({"lint-spec": ["incomplete", "pass", "incomplete"]})
        run = self.start()
        for _ in range(2):
            self.do_role(run, "design", "ready", {"spec_path": "spec-1"})
        self.walker("next", "--run", run)
        self.answer_in_app(run, "approve_spec", "revise")
        self.do_role(run, "design", "ready", {"spec_path": "spec-1"})
        self.walker("next", "--run", run)
        self.answer_in_app(run, "approve_spec", "build", attempt=2)
        self.assertEqual(self.walker("next", "--run", run)["step"], "build")

    def test_a_step_abandoned_past_its_cap_stops_the_run_until_josh_allows_one_more(self):
        run = self.start()
        for _ in range(3):
            self.walker("next", "--run", run)
            self.walker("abandon", "--run", run)
        stopped = self.walker("next", "--run", run)
        self.assertEqual((stopped["action"], stopped["step"]), ("stopped", "design"))
        self.assertIn("as often as its tier allows", stopped["reason"])
        self.assertEqual(self.walker("next", "--run", run)["action"], "stopped")
        self.walker("allow", "--run", run, "--step", "design")
        out = self.walker("next", "--run", run)
        self.assertEqual((out["action"], out["attempt"], out["allowed_by_josh"]), ("run", 4, True))
        self.assertEqual(self.walker("next", "--run", run)["attempt"], 4)   # the grant is used once

    def test_the_sixth_run_on_a_ticket_in_a_day_is_refused_unless_josh_says_so(self):
        for _ in range(5):
            self.start(ticket="JP-902")
        out = self.walker("start", "--graph", "valid", "--ticket", "JP-902", "--input", "system=sample", code=2)
        self.assertIn("5 runs in the last 24 hours", out["error"])
        self.start("valid", "JP-902", "--allow-repeat")
        self.start("valid", "JP-903")


class Asking(WalkerCase):
    def test_a_parked_run_leaves_a_question_in_needs_you_and_a_flag_and_no_session(self):
        run = self.start()
        self.do_role(run, "design", "ready", {"spec_path": "spec-1"})
        parked = self.walker("next", "--run", run)
        record = json.loads((self.tmp / "questions" / (parked["question_id"] + ".json")).read_text())
        self.assertEqual((record["runner"], record["state"], record["ticketKey"]), ("headless", "open", "JP-901"))
        self.assertEqual([o["label"] for o in record["questions"][0]["options"]], ["build", "revise", "drop"])
        self.assertIn("JP-901", record["questions"][0]["question"])
        flags = [e["argv"] for e in self.log() if e.get("effect") == "set-flag.py"]
        self.assertEqual(flags, [["--ticket", "JP-901", "--on"]])
        self.assertEqual(self.walker("status", "--run", run)["flag_on"], True)
        self.assertEqual(self.walker("next", "--run", run)["action"], "parked")      # still parked, nothing changed
        self.answer_in_app(run, "approve_spec", "drop")
        done = self.walker("next", "--run", run)
        self.assertEqual((done["end"], done["score"]), ("approve_spec.drop", "neutral"))
        flags = [e["argv"][-1] for e in self.log() if e.get("effect") == "set-flag.py"]
        self.assertEqual(flags, ["--on", "--off"])
        self.assertEqual(json.loads((self.tmp / "questions" / (parked["question_id"] + ".json")).read_text())["state"],
                         "delivered")

    def test_the_answer_is_saved_as_a_decision_in_its_category(self):
        run = self.start()
        self.do_role(run, "design", "ready", {"spec_path": "spec-1"})
        self.walker("next", "--run", run)
        self.answer_in_app(run, "approve_spec", "build")
        self.walker("next", "--run", run)
        conn = db.connect(db.ledger_path())
        self.addCleanup(conn.close)
        ask = conn.execute("SELECT category, question_key, system, stage FROM asks").fetchone()
        self.assertEqual(ask, ("valid/approve_spec;system=sample;spec_path=spec-1", "valid/approve_spec", "sample", 1))
        decision = conn.execute("SELECT category, answer, how, decided_by FROM decisions").fetchone()
        self.assertEqual(decision, ("valid/approve_spec;system=sample;spec_path=spec-1", "build", "answered", "josh"))
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM open_asks").fetchone()[0], 0)
        self.assertEqual(conn.execute("SELECT found FROM memory_lookups").fetchone()[0], 0)

    def test_a_value_that_is_not_a_short_code_gets_no_precedent(self):
        run = self.start()
        self.do_role(run, "design", "ready", {"spec_path": "/tmp/some path/spec.md"})
        self.walker("next", "--run", run)
        conn = db.connect(db.ledger_path())
        self.addCleanup(conn.close)
        self.assertEqual(conn.execute("SELECT category FROM asks").fetchone()[0],
                         "valid/approve_spec;system=sample;spec_path=_")
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM memory_lookups").fetchone()[0], 0)

    def test_a_precedent_at_stage_two_is_offered_and_confirming_it_says_so(self):
        category = "valid/approve_spec;system=sample;spec_path=spec-1"
        conn = db.connect(db.ledger_path())
        self.addCleanup(conn.close)
        conn.execute("INSERT INTO decisions (category, question_key, system, answer, how, decided_by, decided_at, "
                     "recorded_by) VALUES (?, 'valid/approve_spec', 'sample', 'build', 'answered', 'josh', "
                     "'2026-11-16T10:00:00Z', 'test')", (category,))
        conn.execute("INSERT INTO category_stages (category, stage, set_by, set_at, recorded_by) "
                     "VALUES (?, 2, 'josh', '2026-11-16T11:00:00Z', 'test')", (category,))
        run = self.start()
        self.do_role(run, "design", "ready", {"spec_path": "spec-1"})
        self.walker("next", "--run", run)
        ask = conn.execute("SELECT stage, suggested_answer, precedent_decision_id FROM asks").fetchone()
        self.assertEqual(ask[:2], (2, "build"))
        self.answer_in_app(run, "approve_spec", "build")
        self.walker("next", "--run", run)
        how = conn.execute("SELECT how, rests_on_decision_id FROM decisions WHERE ask_id IS NOT NULL").fetchone()
        self.assertEqual(how, ("confirmed-suggestion", ask[2]))

    def test_typed_text_that_matches_no_choice_is_refused_and_the_question_reopened(self):
        run = self.start()
        self.do_role(run, "design", "ready", {"spec_path": "spec-1"})
        parked = self.walker("next", "--run", run)
        self.answer_in_app(run, "approve_spec", "maybe tomorrow")
        again = self.walker("next", "--run", run)
        self.assertEqual(again["action"], "parked")
        self.assertIn("not one of the choices", again["warnings"][0])
        record = json.loads((self.tmp / "questions" / (parked["question_id"] + ".json")).read_text())
        self.assertEqual(record["state"], "open")

    def test_a_phi_run_stores_no_question_text(self):
        run = self.start("valid", "JP-904", "--phi")
        self.do_role(run, "design", "ready", {"spec_path": "spec-1"})
        self.walker("next", "--run", run)
        conn = db.connect(db.ledger_path())
        self.addCleanup(conn.close)
        self.assertEqual(conn.execute("SELECT question, choices FROM asks").fetchone(), (None, None))

    def test_the_cli_answer_command_writes_the_same_file_the_app_does(self):
        run = self.start()
        self.do_role(run, "design", "ready", {"spec_path": "spec-1"})
        self.walker("next", "--run", run)
        self.walker("answer", "--run", run, "--step", "approve_spec", "--choice", "build")
        self.walker("answer", "--run", run, "--step", "approve_spec", "--choice", "build", code=2)
        self.assertEqual(self.walker("next", "--run", run)["step"], "build")


TYPED = """convention: 1
graph: typed
title: Typed answer sample
description: A made-up question that takes a typed answer.
header:
  jira:
    - { status: Design/Planning, steps: [q, work] }
  entry_gate: ready
  exit_gate: no-loose-ends
  asks_josh: [q]
  ledger: [run, step, outcome]
  access: { q: read, work: josh }
  end_states: { finished: success, q.drop: neutral }
inputs:
  ticket_key: { type: string, required: true }
steps:
  - id: q
    ask:
      question: "What should {{ inputs.ticket_key }} do?"
      choices: [answered, drop]
    on:
      drop: end
  - id: work
    role: designer
    needs: [q]
    outcomes: [done]
"""


class TypedAnswers(WalkerCase):
    def setUp(self):
        super().setUp()
        (self.root / "flows" / "typed.yaml").write_text(TYPED)
        self.assertEqual(self.compile()[0], 0)

    def parked(self, text):
        run = self.walker("start", "--graph", "typed", "--ticket", "JP-905")["run"]
        self.walker("next", "--run", run)
        self.answer_in_app(run, "q", text)
        return run

    def test_a_typed_answer_is_posted_on_the_ticket_and_kept_as_an_output(self):
        run = self.parked("Use the second option, then close it")
        out = self.walker("next", "--run", run)
        self.assertEqual((out["action"], out["step"]), ("run", "work"))
        self.assertEqual(out["jira_status"], "Design/Planning")
        posts = [e for e in self.log() if e.get("effect") == "post-comment.py"]
        self.assertEqual(len(posts), 1)
        body = Path(posts[0]["argv"][-1]).read_text()
        self.assertEqual(body, "Josh's answer: Use the second option, then close it")
        self.assertEqual(json.loads((self.tmp / "runs" / run / "run.json").read_text())["outputs"]["q"],
                         {"answer": "Use the second option, then close it"})

    def test_a_typed_answer_with_patient_data_is_used_but_not_posted(self):
        run = self.parked("Call back at 555-123-4567")
        out = self.walker("next", "--run", run)
        self.assertEqual(out["action"], "run")
        self.assertEqual([e for e in self.log() if e.get("effect") == "post-comment.py"], [])
        self.assertIn("patient-data screen", out["warnings"][0])
        self.assertNotIn("555", json.dumps(out))

    def test_a_typed_answer_on_a_phi_run_is_never_posted(self):
        run = self.walker("start", "--graph", "typed", "--ticket", "JP-906", "--phi")["run"]
        self.walker("next", "--run", run)
        self.answer_in_app(run, "q", "Use the second option, then close it")
        out = self.walker("next", "--run", run)
        self.assertEqual(out["action"], "run")
        self.assertEqual([e for e in self.log() if e.get("effect") == "post-comment.py"], [])
        self.assertIn("patient-data screen", out["warnings"][0])

    def test_a_failed_jira_effect_is_a_warning_and_the_run_goes_on(self):
        os.environ["WALKER_TEST_EFFECT_FAILS"] = "1"
        run = self.parked("Go ahead")
        out = self.walker("next", "--run", run)
        self.assertEqual(out["action"], "run")
        self.assertTrue(any("not posted" in w for w in out["warnings"]))
        os.environ.pop("WALKER_TEST_EFFECT_FAILS")


class Gates(WalkerCase):
    def test_the_gate_gets_the_walker_s_environment(self):
        run = self.start()
        self.do_role(run, "design", "ready", {"spec_path": "spec-1"})
        self.walker("next", "--run", run)
        lint = [e for e in self.log() if e.get("gate") == "lint-spec"][0]
        self.assertEqual((lint["run"], lint["ticket"], lint["runs"]), (run, "JP-901", str(self.tmp / "runs")))

    def test_a_gate_that_fails_stops_the_run_and_is_not_retried_until_josh_says(self):
        self.plan({"lint-spec": ["crash", "pass"]})
        run = self.start()
        self.do_role(run, "design", "ready", {"spec_path": "spec-1"})
        stopped = self.walker("next", "--run", run)
        self.assertEqual((stopped["action"], stopped["step"]), ("stopped", "lint_spec"))
        self.assertIn("scripted crash", stopped["reason"])
        self.assertEqual(self.walker("next", "--run", run)["action"], "stopped")
        self.assertEqual(len([e for e in self.log() if e.get("gate") == "lint-spec"]), 1)
        self.walker("retry", "--run", run)
        self.assertEqual(self.walker("next", "--run", run)["step"], "approve_spec")
        self.assertEqual([r[5] for r in self.step_rows(run) if r[0] == "lint_spec"], ["_error", "pass"])

    def test_an_outcome_the_step_does_not_declare_is_a_failed_gate(self):
        self.plan({"lint-spec": ["surprise"]})
        run = self.start()
        self.do_role(run, "design", "ready", {"spec_path": "spec-1"})
        stopped = self.walker("next", "--run", run)
        self.assertIn("does not declare", stopped["reason"])

    def test_a_gate_that_refuses_at_the_door_starts_nothing(self):
        self.plan({"ready": ["refused"]})
        out = self.walker("start", "--graph", "valid", "--ticket", "JP-906", code=2)
        self.assertIn("did not admit", out["error"])
        conn = db.connect(db.ledger_path())
        self.addCleanup(conn.close)
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM graph_runs").fetchone()[0], 0)
        self.assertEqual(list((self.tmp / "runs").iterdir()), [])

    def test_an_exit_gate_that_refuses_ends_the_run_as_exit_refused(self):
        self.plan({"no-loose-ends": ["open"]})
        run = self.start()
        self.walk_happy(run)
        done = self.walker("next", "--run", run)
        self.assertEqual((done["end"], done["score"]), ("exit_refused", "needs-josh"))

    def test_a_failed_status_move_is_a_warning_and_is_tried_again(self):
        self.plan({"move-ticket": ["crash", "moved"]})
        run = self.start()
        out = self.walker("next", "--run", run)
        self.assertEqual(out["action"], "run")
        self.assertIn("not moved to Design/Planning", out["warnings"][0])
        self.assertIsNone(self.walker("status", "--run", run)["jira_status"])
        self.walker("next", "--run", run)
        self.assertEqual(self.walker("status", "--run", run)["jira_status"], "Design/Planning")


class Ledger(WalkerCase):
    def test_a_ledger_that_does_not_fit_the_graph_stops_the_walker(self):
        run = self.start()
        conn = db.connect(db.ledger_path())
        self.addCleanup(conn.close)
        conn.execute("INSERT INTO step_runs (run_id, step_id, step_kind, attempt, loop_count, started_at, recorded_by) "
                     "VALUES (?, 'lint_spec', 'gate', 1, 0, '2026-11-17T12:00:00Z', 'test')", (run,))
        out = self.walker("next", "--run", run, code=2)
        self.assertIn("comes next", out["error"])

    def test_a_run_whose_folder_is_gone_says_so(self):
        run = self.start()
        import shutil
        shutil.rmtree(str(self.tmp / "runs" / run))
        out = self.walker("next", "--run", run, code=2)
        self.assertIn("run folder", out["error"])

    def test_there_is_no_run_with_that_id(self):
        out = self.walker("next", "--run", "r-000000000000", code=2)
        self.assertIn("no run", out["error"])


if __name__ == "__main__":
    unittest.main()
