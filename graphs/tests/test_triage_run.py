"""JP-122: the whole triage graph, walked with the real walker and the real gate scripts.

Only two things are made up: the sign-off and drafter roles' answers (a test writes each role's result file, as an
agent would) and Jira (a folder-backed fake, JOSH360_JIRA_FAKE, that records every request). Every ticket, key and
session here is invented.

Run: python3 -m unittest discover -s graphs/tests   (from the repository root)
"""
from __future__ import annotations

import io
import json
import os
import re
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

import ticket_creation_helpers as h
import triage_helpers as t

ROOT = h.ROOT
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "graphs" / "tools"))
from ledger import _repo  # noqa: E402,F401
from ledger import db  # noqa: E402
from laptop import common  # noqa: E402
from walker_lib import cli, questions  # noqa: E402

NOW = "2026-11-17T12:00:00Z"
KEY = "JP-9001"


class RunCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="josh360-triage-"))
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        self.saved = dict(os.environ)
        self.addCleanup(self._restore)
        home = self.tmp / "home"
        self.fake = self.tmp / "jira"
        self.fake.mkdir()
        for var in [k for k in os.environ if k.startswith(("JOSH360_", "DESK_", "GRAPH_INPUT_", "ACTION_AGENT_"))]:
            os.environ.pop(var)
        os.environ.update({"JOSH360_HOME": str(home), "JOSH360_RUNS": str(self.tmp / "runs"),
                           "JOSH360_QUESTIONS_DIR": str(self.tmp / "questions"), "JOSH360_JIRA_FAKE": str(self.fake)})
        db.ensure(home / "state" / "ledger.db", home / "backups", NOW)
        self.seed([t.issue(), t.issue("JP-94", type_="Epic", desc=None)])

    def _restore(self):
        os.environ.clear()
        os.environ.update(self.saved)

    # -- Jira ----------------------------------------------------------------------------------------------------
    def seed(self, issues, properties=None, comments=None):
        t.seed(self.fake, issues, properties, comments)

    def state(self):
        return json.loads((self.fake / "fake-jira.json").read_text())

    def edit(self, key, **fields):
        state = self.state()
        state["issues"][key]["fields"].update(fields)
        (self.fake / "fake-jira.json").write_text(json.dumps(state))

    def status(self, key=KEY):
        return self.state()["issues"][key]["fields"]["status"]["name"]

    def comments(self, key=KEY):
        return [c["body"] for c in self.state()["comments"].get(key, [])]

    def prop(self, name, key=KEY):
        return self.state()["properties"].get("{}|{}".format(key, name))

    def writes(self):
        path = self.fake / "calls.jsonl"
        calls = [json.loads(line) for line in path.read_text().splitlines()] if path.is_file() else []
        return [c for c in calls if c["method"] != "GET" and c["path"] != "/rest/api/3/search/jql"]

    # -- the walker ----------------------------------------------------------------------------------------------
    def walker(self, *argv, code=0):
        out = io.StringIO()
        got = cli.main(["--root", str(ROOT / "graphs")] + [str(a) for a in argv], out)
        self.assertEqual(got, code, out.getvalue())
        text = out.getvalue()
        return json.loads(text) if text.strip().startswith("{") else text

    def start(self, ticket=KEY, code=0):
        got = self.walker("start", "--graph", "triage", "--ticket", ticket, code=code)
        return got["run"] if code == 0 else got

    def nxt(self, run):
        return self.walker("next", "--run", run)

    def role(self, run, step, outcome, outputs, session):
        out = self.nxt(run)
        self.assertEqual((out["action"], out["step"]), ("run", step), out)
        result = Path(out["result_file"])
        result.write_text(json.dumps({"outcome": outcome, "outputs": outputs}))
        self.walker("record", "--run", run, "--step", step, "--result-file", result, "--session", session)
        return out

    def answer(self, run, step, choice, attempt=1):
        self.walker("answer", "--run", run, "--step", step, "--choice", choice)

    def to_end(self, run):
        done = self.nxt(run)
        self.assertEqual(done["action"], "done", done)
        return done

    def signs_off(self, run, session="s-signer", defects=None):
        outcome = "defects" if defects else "ready"
        return self.role(run, "sign_off", outcome, {"defects": defects or []}, session)

    # -- made-up role answers --------------------------------------------------------------------------------------
    def file(self, name, value):
        return h.write_json(self.tmp / name, value)

    def revision(self, sections, key=KEY, closes=(1,), session="s-drafter", **over):
        body = {"action": "revise", "closes": list(closes), "authors": [session],
                "tickets": [{"key": key, "type": "Story", "repository": "josh-360", "where_it_runs": "Cloud session",
                             "sections": sections}]}
        body.update(over)
        return self.file("revision.json", body)

    def finishes_at_the_exit(self, run):
        """The exit gate (`no-loose-ends`, JP-161) stops the run until the recorder has written the episodes of the
        run's sessions, since what they left is unknown until then. Once they are recorded, a retry finishes it."""
        out = self.nxt(run)
        self.assertEqual((out["action"], out["step"]), ("stopped", "_exit"), out)
        self.assertIn("not recorded yet", out["reason"])
        self.record_sessions(run)
        self.walker("retry", "--run", run)
        done = self.nxt(run)
        self.assertEqual(done["action"], "done", done)
        self.assertEqual(self.walker("status", "--run", run)["ended"], "finished")

    def record_sessions(self, run):
        """What the recorder writes once a session goes quiet: an episode, here in a folder that is no repository, so
        the session touched nothing that can be loose."""
        conn = db.connect(Path(os.environ["JOSH360_HOME"]) / "state" / "ledger.db")
        try:
            uids = {r[0] for r in conn.execute(
                "SELECT x.session_uid FROM step_results x JOIN step_runs r ON r.id = x.step_run_id "
                "WHERE r.run_id = ? AND x.session_uid IS NOT NULL", (run,))}
            now = common.now_utc()
            for uid in uids:
                conn.execute(
                    "INSERT INTO session_episodes (session_uid, episode, began_at, last_activity_at, quiet_at, "
                    "end_reason, folder, title, title_source, recorded_at, recorded_by) "
                    "VALUES (?, 1, ?, ?, ?, 'session-end', ?, 'A title', 'ai', ?, 'test')",
                    (uid, now, now, now, str(self.tmp / "not-a-repository"), now))
            conn.commit()
        finally:
            conn.close()


class AnOwnTicketBecomesReady(RunCase):
    def test_a_complete_own_ticket_becomes_ready_with_one_route(self):
        run = self.start()
        self.signs_off(run)
        self.finishes_at_the_exit(run)
        self.assertEqual(self.status(), "Ready")
        route = self.prop("josh360.route")
        self.assertEqual((route["graph"], route["system"], route["signed_by"]), ("development", "josh-360", "s-signer"))
        self.assertNotIn("priority", json.dumps(self.writes()).lower())
        self.assertEqual(len(self.comments()), 1)

    def test_the_comment_on_ready_is_in_the_result_evidence_next_gate_shape(self):
        run = self.start()
        self.signs_off(run)
        self.finishes_at_the_exit(run)
        text = json.dumps(self.state()["comments"][KEY])
        self.assertIn("Triage: Ready | run {}, signed off by session s-signer".format(run), text)
        self.assertIn("route: development (josh-360) | next gate: starts when Josh queues it", text)

    def test_the_route_record_is_written_before_the_move(self):
        run = self.start()
        self.signs_off(run)
        self.finishes_at_the_exit(run)
        paths = [w["path"] for w in self.writes()]
        self.assertLess(paths.index("/rest/api/3/issue/JP-9001/properties/josh360.route"),
                        paths.index("/rest/api/3/issue/JP-9001/transitions"))

    def test_triage_writes_nothing_before_the_sign_off_verdict(self):
        run = self.start()
        out = self.nxt(run)
        self.assertEqual(out["step"], "sign_off")
        self.assertEqual(self.writes(), [])

    def test_the_signing_session_is_never_an_author(self):
        self.seed([t.issue(), t.issue("JP-94", type_="Epic", desc=None)], {"JP-9001|josh360.authors": ["s-author"]})
        run = self.start()
        self.signs_off(run, session="s-author")
        again = self.nxt(run)                        # invalid: a fresh sign-off session judges it once more
        self.assertEqual((again["step"], again["attempt"]), ("sign_off", 2), again)
        self.assertEqual(self.status(), "Not Started")
        self.signs_off_again(run, "s-other")
        self.finishes_at_the_exit(run)
        self.assertEqual(self.status(), "Ready")
        self.assertEqual(self.prop("josh360.route")["signed_by"], "s-other")

    def signs_off_again(self, run, session):
        result = self.nxt(run)
        self.assertEqual(result["step"], "sign_off")
        Path(result["result_file"]).write_text(json.dumps({"outcome": "ready", "outputs": {"defects": []}}))
        self.walker("record", "--run", run, "--step", "sign_off", "--result-file", result["result_file"],
                    "--session", session)

    def test_a_defect_that_quotes_nothing_is_dropped_and_recorded(self):
        run = self.start()
        made_up = {"item": "J1", "quote": "this sentence is not in the ticket", "problem": "unclear", "needed": "more"}
        self.signs_off(run, defects=[made_up])
        self.finishes_at_the_exit(run)                # nothing survived, so the ticket is Ready
        self.assertEqual(self.status(), "Ready")
        dropped = json.loads((self.tmp / "runs" / run / "outputs" / "dropped-defects.json").read_text())
        self.assertEqual(dropped[0]["reason"], "quote not in ticket")

    def test_a_kept_defect_sends_an_own_ticket_to_the_drafter(self):
        run = self.start()
        defect = {"item": "J1", "quote": "Read STEPS in laptop/install.py.", "problem": "it names no file to change",
                  "needed": "name the file the flag goes in"}
        self.signs_off(run, defects=[defect])
        out = self.nxt(run)
        self.assertEqual(out["step"], "revise")
        self.assertEqual(out["inputs"]["gaps"][0]["item"], "J1")


class ACheckThatFailsGoesToTheDrafterAndBack(RunCase):
    def incomplete(self):
        self.seed([t.issue(desc=t.description(sections={"first_step": ""})), t.issue("JP-94", type_="Epic", desc=None)])

    def test_the_drafter_closes_the_gap_and_the_ticket_becomes_ready(self):
        self.incomplete()
        run = self.start()
        out = self.nxt(run)
        self.assertEqual(out["step"], "revise")
        self.assertTrue(out["inputs"]["gaps"], out)
        before = self.writes()
        self.assertEqual(before, [])
        fixed = self.revision(h.section_set(), session="s-drafter")
        self.walker("record", "--run", run, "--step", "revise", "--result-file", self.file("r.json", {
            "outcome": "revised", "outputs": {"proposal": fixed}}), "--session", "s-drafter")
        self.signs_off(run)
        self.finishes_at_the_exit(run)
        self.assertEqual(self.status(), "Ready")
        self.assertIn("s-drafter", self.prop("josh360.authors"))
        texts = [json.dumps(c) for c in self.state()["comments"][KEY]]
        self.assertTrue(any("revised by the ticket drafter, round 1 of 2 | run " + run in c for c in texts), texts)
        self.assertEqual(self.prop("josh360.route")["signed_by"], "s-signer")

    def test_a_drafter_who_cannot_answer_returns_one_question_and_josh_is_asked(self):
        self.incomplete()
        run = self.start()
        self.assertEqual(self.nxt(run)["step"], "revise")
        needs = {"action": "revise", "needs_josh": {"question": "Which file holds the first step?",
                                                    "recommendation": "laptop/install.py", "reason": "it holds STEPS"}}
        self.walker("record", "--run", run, "--step", "revise", "--result-file", self.file("r.json", {
            "outcome": "needs_josh", "outputs": {"proposal": self.file("n.json", needs)}}), "--session", "s-drafter")
        parked = self.nxt(run)
        self.assertEqual((parked["action"], parked["step"]), ("parked", "ask_josh"), parked)
        self.assertIn("Triage: one question for Josh | run " + run, json.dumps(self.state()["comments"][KEY]))
        self.assertEqual(self.status(), "Not Started")

    def test_two_drafter_rounds_then_josh(self):
        self.incomplete()
        run = self.start()
        for attempt in (1, 2):
            out = self.nxt(run)
            self.assertEqual((out["step"], out["attempt"]), ("revise", attempt), out)
            same = self.revision(h.section_set(first_step=""), session="s-drafter")
            self.walker("record", "--run", run, "--step", "revise", "--result-file", self.file("r.json", {
                "outcome": "revised", "outputs": {"proposal": same}}), "--session", "s-drafter")
        out = self.nxt(run)
        self.assertEqual((out["action"], out["step"]), ("parked", "ask_at_limit"), out)
        notes = [c for c in map(json.dumps, self.state()["comments"][KEY]) if "revised by the ticket drafter" in c]
        self.assertEqual(len(notes), 2)                      # exactly two rounds were written, never a third
        text = json.dumps(questions.read(out["question_id"]))          # JP-195: the question says why
        self.assertIn("ended with `exhausted`", text)
        self.assertNotIn("gaps are on the ticket", text)

    def test_one_more_round_runs_the_drafter_once_more_and_then_asks_again(self):
        self.incomplete()
        run = self.start()
        same = self.revision(h.section_set(first_step=""), session="s-drafter")
        for _ in (1, 2):
            self.assertEqual(self.nxt(run)["step"], "revise")
            self.walker("record", "--run", run, "--step", "revise", "--result-file", self.file("r.json", {
                "outcome": "revised", "outputs": {"proposal": same}}), "--session", "s-drafter")
        self.assertEqual(self.nxt(run)["step"], "ask_at_limit")
        self.answer(run, "ask_at_limit", "one_more_round")
        self.assertEqual(self.nxt(run)["step"], "revise")    # a third round, because Josh chose it
        self.walker("record", "--run", run, "--step", "revise", "--result-file", self.file("r.json", {
            "outcome": "revised", "outputs": {"proposal": same}}), "--session", "s-drafter")
        self.assertEqual(self.nxt(run)["step"], "ask_at_limit")      # and then Josh is asked again, not looped past

    def test_a_drafter_cannot_change_the_type_or_edit_someone_elses_ticket(self):
        self.incomplete()
        run = self.start()
        self.assertEqual(self.nxt(run)["step"], "revise")
        bad = self.revision(h.section_set())
        data = json.loads(Path(bad).read_text())
        data["tickets"][0]["type"] = "Bug"
        self.walker("record", "--run", run, "--step", "revise", "--result-file", self.file("r.json", {
            "outcome": "revised", "outputs": {"proposal": self.file("bad.json", data)}}), "--session", "s-drafter")
        out = self.nxt(run)
        self.assertEqual(out["action"], "stopped", out)
        self.assertIn("not a revision", out["reason"])
        self.assertNotIn("/description", json.dumps(self.writes()))
        self.assertEqual([w["path"] for w in self.writes()], ["/rest/api/3/issue/JP-9001"])   # only the walker's flag
        self.assertEqual(self.status(), "Not Started")


def drafter_examples():
    """The JSON blocks of the ticket drafter's "Revising a ticket that already exists" section, in order: the revised
    result, its proposal, the needs_josh result, its proposal (JP-184)."""
    text = (ROOT / "graphs" / "roles" / "ticket-drafter" / "instructions.md").read_text()
    section = text.split("## Revising a ticket that already exists")[1]
    # A result block is tagged with its step (```json result step=revise, JP-189); a proposal block is plain ```json.
    return [json.loads(block.split("```", 1)[0]) for block in re.split(r"```json[^\n]*\n", section)[1:]]


class TheDrafterIsToldItsOutputs(RunCase):
    """JP-184: the laptop proof run's drafter put the proposal's own fields straight under "outputs", and the walker
    refused the result. The step's answer names its output, a wrong shape is refused with that name, and the shape
    the drafter's instructions show is recorded and read by the gates."""

    def incomplete(self):
        self.seed([t.issue(desc=t.description(sections={"first_step": ""})), t.issue("JP-94", type_="Epic", desc=None)])

    def test_the_revise_answer_names_its_one_output_and_its_contract(self):
        self.incomplete()
        out = self.nxt(self.start())
        self.assertEqual(out["step"], "revise")
        self.assertEqual(list(out["outputs"]), ["proposal"])
        spec = out["outputs"]["proposal"]
        self.assertEqual(spec["type"], "string")
        self.assertIn("Path", spec["description"])
        self.assertTrue(spec["contract_file"].endswith("graphs/contracts/ticket-proposal.md"), spec)
        self.assertTrue(Path(spec["contract_file"]).is_file())

    def test_the_proposal_fields_straight_under_outputs_are_refused_by_the_name_expected(self):
        self.incomplete()
        run = self.start()
        out = self.nxt(run)
        proposal = json.loads(Path(self.revision(h.section_set())).read_text())
        refused = self.walker("record", "--run", run, "--step", "revise", "--result-file", self.file("bad.json", {
            "outcome": "revised", "outputs": proposal}), "--session", "s-drafter", code=2)
        self.assertIn("does not declare the output 'action'", refused["error"])
        self.assertIn("it declares proposal", refused["error"])
        self.assertEqual(self.writes(), [])
        # The step is still waiting, so the right shape is recorded on the same attempt.
        self.walker("record", "--run", run, "--step", "revise", "--result-file", self.file("r.json", {
            "outcome": "revised", "outputs": {"proposal": self.revision(h.section_set())}}), "--session", "s-drafter")
        self.assertEqual(self.nxt(run)["step"], "sign_off")
        self.assertEqual(out["attempt"], 1)

    def example(self, result, proposal, run):
        work = Path(self.nxt(run)["work_dir"])
        target = work / Path(result["outputs"]["proposal"]).name
        target.write_text(json.dumps(proposal))
        self.assertEqual(list(result["outputs"]), ["proposal"])
        return self.file("r.json", dict(result, outputs={"proposal": str(target)}))

    def test_the_instructions_revised_example_is_recorded_and_applied(self):
        revised, proposal, _, _ = drafter_examples()
        self.assertEqual(revised["outcome"], "revised")
        proposal["tickets"][0]["key"] = KEY
        proposal["authors"] = ["s-drafter"]
        self.incomplete()
        run = self.start()
        self.walker("record", "--run", run, "--step", "revise", "--result-file",
                    self.example(revised, proposal, run), "--session", "s-drafter")
        self.nxt(run)   # apply_revision writes it, then the checks run again
        texts = [json.dumps(c) for c in self.state()["comments"][KEY]]
        self.assertTrue(any("revised by the ticket drafter, round 1 of 2 | run " + run in c for c in texts), texts)

    def test_the_instructions_needs_josh_example_is_recorded_and_posted(self):
        _, _, needs, proposal = drafter_examples()
        self.assertEqual(needs["outcome"], "needs_josh")
        self.assertEqual(sorted(proposal), ["action", "needs_josh"])
        self.incomplete()
        run = self.start()
        self.walker("record", "--run", run, "--step", "revise", "--result-file",
                    self.example(needs, proposal, run), "--session", "s-drafter")
        parked = self.nxt(run)
        self.assertEqual((parked["action"], parked["step"]), ("parked", "ask_josh"), parked)
        self.assertIn(proposal["needs_josh"]["question"], json.dumps(self.state()["comments"][KEY]))


class SomeoneElsesTicket(RunCase):
    def other(self, **over):
        key = over.pop("key", KEY)
        queued = {"created": "2026-11-17T10:00:00.000+0000", "author": {"accountId": t.ME},
                  "items": [{"field": "Agent Status", "fieldId": "customfield_10453", "fromString": None,
                             "toString": "Queued"}]}
        self.seed([t.issue(key, creator=t.OTHER, type_="Task", **over), t.issue("JP-94", type_="Epic", desc=None)])
        state = self.state()
        state["changelogs"] = {key: [queued]}
        (self.fake / "fake-jira.json").write_text(json.dumps(state))

    UNTAGGED = h.GHERKIN.replace("  @auto\n", "")

    def test_a_gap_gets_one_comment_and_no_edit_and_josh_is_not_asked(self):
        self.other(desc=t.description(type="Task", sections={"acceptance_criteria": self.UNTAGGED}))
        run = self.start()
        done = self.nxt(run)
        self.assertEqual((done["action"], done["end"]), ("done", "send_back.sent"), done)
        self.assertEqual(len(self.comments()), 1)
        self.assertIn("Triage: not Ready yet | run " + run, json.dumps(self.state()["comments"][KEY]))
        self.assertIn("C6", json.dumps(self.state()["comments"][KEY]))
        self.assertEqual([w["path"] for w in self.writes()], ["/rest/api/3/issue/JP-9001/comment"])
        self.assertEqual(self.status(), "Not Started")

    def test_a_ticket_edited_mid_run_reaches_josh_only_as_a_limit_and_the_drafter_never_runs(self):
        self.other(desc=t.description(type="Task"))
        run = self.start()
        self.assertEqual(self.nxt(run)["step"], "sign_off")
        self.edit(KEY, summary="Add a dry-run flag, edited by its author")          # the author edits mid-run
        result = self.nxt(run)
        Path(result["result_file"]).write_text(json.dumps({"outcome": "ready", "outputs": {"defects": []}}))
        self.walker("record", "--run", run, "--step", "sign_off", "--result-file", result["result_file"],
                    "--session", "s-1")
        self.assertEqual(self.nxt(run)["step"], "sign_off")                          # invalid once: judged again
        self.signs_off_once_more(run, "s-2")
        parked = self.nxt(run)
        self.assertEqual((parked["action"], parked["step"]), ("parked", "ask_at_limit"), parked)
        self.assertNotIn("/description", json.dumps(self.writes()))
        self.assertEqual(self.status(), "Not Started")

    def signs_off_once_more(self, run, session):
        out = self.nxt(run)
        Path(out["result_file"]).write_text(json.dumps({"outcome": "ready", "outputs": {"defects": []}}))
        self.walker("record", "--run", run, "--step", "sign_off", "--result-file", out["result_file"],
                    "--session", session)

    def test_a_ticket_nobody_queued_is_not_admitted(self):
        self.seed([t.issue(creator=t.OTHER, type_="Task"), t.issue("JP-94", type_="Epic", desc=None)])
        refused = self.start(code=2)
        self.assertIn("did not admit the run", json.dumps(refused))   # the gate's own reason is tested in test_triage_gates
        self.assertEqual(self.writes(), [])


class RoutingAndRepeats(RunCase):
    def test_a_code_work_kind_with_no_repository_is_a_conflict_and_goes_back_to_the_drafter(self):
        self.seed([t.issue(type_="Task", desc=t.description(type="Task", repository="none")),
                   t.issue("JP-94", type_="Epic", desc=None)], {"JP-9001|action-triage.spec": {"type": "code"}})
        run = self.start()
        out = self.nxt(run)
        self.assertEqual(out["step"], "revise", out)
        self.assertEqual(out["inputs"]["gaps"][0]["item"], "ROUTE")

    def test_a_ticket_with_an_open_run_is_not_admitted_twice(self):
        self.start()
        refused = self.start(code=2)
        self.assertIn("did not admit the run", json.dumps(refused))


class ReturnsFromAnotherGraph(RunCase):
    RETURN = {"id": "c-ret-{}", "created": "2026-11-17T10:0{}:00.000+0000"}

    def returned(self, count):
        notes = [{"id": "c-ret-{}".format(i), "created": "2026-11-17T10:0{}:00.000+0000".format(i),
                  "body": "Returned to triage | from run r-{} | next gate: Ready check\nWhich table holds this?".format(i)}
                 for i in range(1, count + 1)]
        desc = t.description(sections={"why": "Josh wants a preview.\nWhich table holds this?"})
        self.seed([t.issue(desc=desc), t.issue("JP-94", type_="Epic", desc=None)], comments={KEY: notes})

    def test_a_designer_question_returns_through_triage_and_the_drafter_writes_the_answer(self):
        self.returned(1)
        run = self.start()
        out = self.nxt(run)
        self.assertEqual(out["step"], "revise")
        answered = h.section_set(decisions_already_made=["The table is ledger.sessions (docs/decisions.md)"])
        self.walker("record", "--run", run, "--step", "revise", "--result-file", self.file("r.json", {
            "outcome": "revised", "outputs": {"proposal": self.revision(answered)}}), "--session", "s-drafter")
        self.signs_off(run)
        self.finishes_at_the_exit(run)
        self.assertEqual(self.status(), "Ready")
        route = self.prop("josh360.route")
        self.assertEqual((route["returns"], route["returned_from"]), (1, "c-ret-1"))

    def test_a_third_return_goes_to_josh_and_the_drafter_is_not_started(self):
        self.returned(3)
        run = self.start()
        out = self.nxt(run)
        self.assertEqual((out["action"], out["step"]), ("parked", "ask_returned"), out)
        self.assertNotIn("revise", json.dumps(self.walker("status", "--run", run)))

    def test_josh_answering_resets_the_count_and_the_drafter_runs(self):
        self.returned(3)
        run = self.start()
        self.assertEqual(self.nxt(run)["step"], "ask_returned")
        self.answer(run, "ask_returned", "answered")
        self.assertEqual(self.nxt(run)["step"], "revise")


class LoopCountersBelongToTheirArrow(unittest.TestCase):
    """Spec rule 12, on the real triage graph and the real engine: no run of the steps again resets another arrow."""

    def test_a_drafter_round_leaves_the_mark_ready_count_at_two(self):
        from walker_lib import engine, graphfile
        g = graphfile.load("triage", ROOT / "graphs")
        st = engine.State()

        def go(step, outcome):
            engine.begin(g, st, step)
            engine.finish(g, st, step, outcome)

        def to_mark_ready_changed():
            for step, outcome in (("read_ticket", "read"), ("ready_check", "pass"), ("route", "development"),
                                  ("sign_off", "ready"), ("check_sign_off", "ready"), ("verdict", "ready"),
                                  ("mark_ready", "changed")):
                if step == "sign_off":
                    st.runs["sign_off"] = 0           # the sign-off tier cap is not what this test is about
                go(step, outcome)

        to_mark_ready_changed()
        to_mark_ready_changed()
        self.assertEqual(st.loops[("mark_ready", "read_ticket")], 2)
        for step, outcome in (("read_ticket", "read"), ("ready_check", "gaps"), ("verdict", "revise"),
                              ("revise", "revised"), ("apply_revision", "applied")):
            go(step, outcome)
        self.assertEqual(st.loops[("mark_ready", "read_ticket")], 2)        # the drafter's round did not reset it
        self.assertEqual(st.loops[("apply_revision", "read_ticket")], 1)    # and has its own count

    def test_a_ticket_changed_three_times_reaches_josh_as_a_limit_and_one_more_round_goes_back_to_read_ticket(self):
        from walker_lib import engine, graphfile
        g = graphfile.load("triage", ROOT / "graphs")
        st = engine.State()
        for trip in (1, 2, 3):
            for step, outcome in (("read_ticket", "read"), ("ready_check", "pass"), ("route", "development"),
                                  ("sign_off", "ready"), ("check_sign_off", "ready"), ("verdict", "ready"),
                                  ("mark_ready", "changed")):
                if step == "sign_off":
                    st.runs["sign_off"] = 0
                engine.begin(g, st, step)
                engine.finish(g, st, step, outcome)
        self.assertEqual((st.forced.ask, st.forced.reason), ("ask_at_limit", "loop"))
        engine.begin(g, st, "ask_at_limit")
        engine.finish(g, st, "ask_at_limit", "one_more_round")
        self.assertIsNone(st.forced)
        self.assertEqual(engine.decide(g, st).step, "read_ticket")          # read and checked again; no drafter


class TheHandOffToTheTargetGraph(RunCase):
    def test_a_ready_task_with_no_repository_is_admitted_by_the_non_development_graph_and_not_the_other(self):
        self.seed([t.issue(type_="Task", labels=[], desc=t.description(type="Task", repository="none")),
                   t.issue("JP-94", type_="Epic", desc=None)])
        run = self.start()
        self.signs_off(run)
        self.finishes_at_the_exit(run)
        self.assertEqual(self.prop("josh360.route")["graph"], "non-development")
        started = self.walker("start", "--graph", "non-development", "--ticket", KEY)
        self.assertTrue(started["started"], started)

    def test_a_ticket_edited_after_sign_off_is_not_admitted_by_the_target_graph(self):
        self.seed([t.issue(type_="Task", labels=[], desc=t.description(type="Task", repository="none")),
                   t.issue("JP-94", type_="Epic", desc=None)])
        run = self.start()
        self.signs_off(run)
        self.finishes_at_the_exit(run)
        self.edit(KEY, summary="Edited after sign-off")
        refused = self.walker("start", "--graph", "non-development", "--ticket", KEY, code=2)
        self.assertIn("did not admit", json.dumps(refused))


if __name__ == "__main__":
    unittest.main()
