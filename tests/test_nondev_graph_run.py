"""JP-123, Task 6: whole runs of the non-development graph, through JP-114's real walker.

The walker, the ledger and the graph file are real. Each gate script's own `run` is called in-process with fakes for
Jira, the desk mailer and the draft tool (a gate script that is run for real needs a Jira token), and a role step is
played by the test, which saves files and records the role's outcome. Made-up tickets only, and no network.
"""
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

from walker_helpers import ROOT, WalkerCase

sys.path.insert(0, str(ROOT / "graphs" / "tests"))
from nondev_helpers import DESCRIPTION, KEY, FakeTicket, gate, make_deps, write_artifacts  # noqa: E402
from lib.gate_run import GateError  # noqa: E402
from walker_lib import gates  # noqa: E402

GRAPHS = ROOT / "graphs"
STUBS = ("ready", "no-loose-ends")   # owned by JP-122 and JP-109: not built here, so the test lets them pass


class NonDevelopmentRun(WalkerCase):
    def setUp(self):
        super().setUp()
        self.root = GRAPHS
        self.ticket = FakeTicket()
        self.deps = make_deps(self.tmp, ticket=self.ticket)
        self.flags = []
        for target, replacement in (("run_gate", self.run_gate), ("set_flag", self.set_flag),
                                    ("post_comment", self.post_comment)):
            patcher = mock.patch.object(gates, target, replacement)
            patcher.start()
            self.addCleanup(patcher.stop)

    # --- the in-process stand-ins for the walker's subprocesses -----------------------------------------------
    def run_gate(self, root, name, env, cwd, outcomes):
        if name in STUBS:
            return gates.GateResult("pass", {}, None, None)
        inputs = {k[len("GRAPH_INPUT_"):].lower(): v for k, v in env.items() if k.startswith("GRAPH_INPUT_")}
        try:
            outcome, outputs, summary = gate(name).run(inputs, self.deps)
        except GateError as exc:
            return gates.GateResult(None, {}, None, "gate '{}' failed: {}".format(name, exc))
        self.assertIn(outcome, outcomes or [outcome], "gate {} printed an undeclared outcome".format(name))
        return gates.GateResult(outcome, outputs or {}, summary, None)

    def set_flag(self, root, ticket, on, env):
        self.flags.append(on)
        return True, ""

    def post_comment(self, root, ticket, body_file, env):
        self.ticket.posted.append((ticket, Path(body_file).read_text()))
        return True, ""

    # --- helpers ----------------------------------------------------------------------------------------------
    def begin(self, **inputs):
        inputs.setdefault("phi", "false")                        # the graph's own default is true
        args = ["--phi"] if inputs["phi"] == "true" else []
        pairs = []
        for name, value in inputs.items():
            pairs += ["--input", "{}={}".format(name, value)]
        out = self.walker("start", "--graph", "non-development", "--ticket", KEY, "--input", "system=widgets", *pairs, *args)
        return out["run"]

    def do_work(self, run, outcome="done", files=True, **art):
        out = self.walker("next", "--run", run)
        self.assertEqual(out["step"], "do_work", out)
        if files:
            deliverable, evidence = write_artifacts(self.tmp, **art)
            outputs = {"deliverable_path": str(deliverable), "evidence_path": str(evidence)}
        else:
            outputs = {"deliverable_path": str(self.tmp / "artifacts" / "widgets" / "JP-9001-nothing.md"),
                       "evidence_path": str(self.tmp / "artifacts" / "widgets" / "JP-9001-evidence.md")}
        return self.record(run, "do_work", outcome, outputs)

    def record(self, run, step, outcome, outputs=None):
        out = self.walker("next", "--run", run)
        self.assertEqual(out["step"], step, out)
        rf = Path(out["result_file"])
        rf.write_text(json.dumps({"outcome": outcome, "outputs": outputs or {}}))
        self.walker("record", "--run", run, "--step", step, "--result-file", rf)
        return outputs

    def to_the_work(self, run):
        """Through read_ticket, start_run and the lookup, to the first work run."""
        self.assertEqual(self.walker("next", "--run", run)["step"], "find_precedent")
        self.record(run, "find_precedent", "none", {"candidates": []})

    def finish_review(self, run):
        self.assertEqual(self.walker("next", "--run", run)["step"], "review_work")
        self.record(run, "review_work", "pass", {"findings": []})

    def comments(self):
        return [text for _, text in self.ticket.posted]

    # --- the scenarios ----------------------------------------------------------------------------------------
    def test_ticket_ends_in_deliverable_with_sources(self):
        run = self.begin()
        self.to_the_work(run)
        outputs = self.do_work(run)
        self.finish_review(run)
        parked = self.walker("next", "--run", run)
        self.assertEqual((parked["action"], parked["step"]), ("parked", "sign_off"))
        self.assertEqual(self.ticket.tickets[KEY].status, "Validation")
        self.answer_in_app(run, "sign_off", "accept")
        done = self.walker("next", "--run", run)
        self.assertEqual((done["action"], done["end"], done["score"]), ("done", "finished", "success"))
        self.assertEqual(self.ticket.tickets[KEY].status, "Done")
        self.assertTrue(Path(outputs["deliverable_path"]).is_file())
        self.assertIn("sources:", self.comments()[-1])
        self.assertTrue(self.comments()[-1].startswith("Resolution: "))
        self.assertTrue(any(c.startswith("Deliverable ready | ") for c in self.comments()))
        self.assertEqual(self.deps.mails, [])
        self.assertEqual([s for _, s in self.ticket.moves][-3:], ["In Progress", "Validation", "Done"])

    def test_email_origin_closes_without_sign_off(self):
        run = self.begin(origin="email", desk_row="42")
        self.to_the_work(run)
        self.do_work(run)
        self.finish_review(run)
        done = self.walker("next", "--run", run)
        self.assertEqual((done["action"], done["end"], done["score"]), ("done", "close_emailed.closed", "success"))
        self.assertEqual(len(self.deps.mails), 1)
        self.assertEqual(self.ticket.tickets[KEY].status, "Done")
        rows = [r[0] for r in self.step_rows(run)]
        self.assertNotIn("sign_off", rows)

    def test_shared_write_waits_for_accept_and_share(self):
        run = self.begin()
        self.to_the_work(run)
        self.do_work(run, recipient="sam@example.com")
        self.finish_review(run)
        self.assertEqual(self.walker("next", "--run", run)["step"], "sign_off")
        self.assertEqual(self.deps.drafts, [])                   # nothing shared while Josh has not answered
        self.answer_in_app(run, "sign_off", "accept_and_share")
        done = self.walker("next", "--run", run)
        self.assertEqual(done["action"], "done")
        self.assertEqual([d[0] for d in self.deps.drafts], ["sam@example.com"])
        self.assertIn("Shared | sam@example.com | next gate: close", self.comments())

    def test_accept_alone_shares_nothing(self):
        run = self.begin()
        self.to_the_work(run)
        self.do_work(run, recipient="sam@example.com")
        self.finish_review(run)
        self.walker("next", "--run", run)
        self.answer_in_app(run, "sign_off", "accept")
        self.assertEqual(self.walker("next", "--run", run)["action"], "done")
        self.assertEqual(self.deps.drafts, [])

    def test_deliverable_outlives_temp_workdir(self):
        run = self.begin()
        self.to_the_work(run)
        outputs = self.do_work(run)
        self.finish_review(run)
        self.walker("next", "--run", run)
        self.answer_in_app(run, "sign_off", "accept")
        self.assertEqual(self.walker("next", "--run", run)["action"], "done")
        from walker_lib import runfolder
        import shutil
        shutil.rmtree(str(runfolder.folder(run)))                # the run's own working folder goes
        self.assertTrue(Path(outputs["deliverable_path"]).is_file())
        self.assertTrue(Path(outputs["evidence_path"]).is_file())

    def test_phi_ticket_comments_hold_paths_only(self):
        run = self.begin(phi="true", origin="email", desk_row="42")
        self.to_the_work(run)
        self.do_work(run, phi=True, summary="Jane Roe had 3 visits", resolution="Q | Jane's visits")
        self.finish_review(run)
        self.assertEqual(self.walker("next", "--run", run)["action"], "done")
        everything = "\n".join(self.comments()) + "".join(Path(a[a.index("--body-file") + 1]).read_text()
                                                           for a in self.deps.mails)
        self.assertNotIn("Jane", everything)
        self.assertIn("summary withheld: patient data", everything)
        self.assertIn("Resolution: withheld: patient data | withheld: patient data", everything)

    def test_do_work_runs_at_most_three_times_before_decide_stuck(self):
        run = self.begin()
        self.to_the_work(run)
        for _ in range(3):                                       # no files are ever saved, so each run is incomplete
            self.do_work(run, files=False)
        parked = self.walker("next", "--run", run)
        self.assertEqual((parked["action"], parked["step"]), ("parked", "decide_stuck"))
        attempts = [r[1] for r in self.step_rows(run) if r[0] == "do_work"]
        self.assertEqual(attempts, [1, 2, 3])
        self.answer_in_app(run, "decide_stuck", "stop")
        done = self.walker("next", "--run", run)
        self.assertEqual((done["action"], done["score"]), ("done", "needs-josh"))
        self.assertNotEqual(self.ticket.tickets[KEY].status, "Done")

    def test_an_unworkable_ticket_goes_back_to_triage(self):
        self.ticket.tickets[KEY] = self.ticket.tickets[KEY]._replace(route={"graph": "development"})
        run = self.begin()
        done = self.walker("next", "--run", run)
        self.assertEqual((done["action"], done["end"], done["score"]), ("done", "return_early.returned", "neutral"))
        self.assertEqual(self.ticket.tickets[KEY].status, "Not Started")
        self.assertEqual(self.comments(), ["Returned to triage | the ticket is not routed to the non-development graph "
                                           "| next gate: triage"])
        self.assertEqual(self.ticket.flags, [(KEY, True)])
        self.assertEqual(self.deps.mails, [])

    def test_work_that_needs_code_goes_back_to_triage(self):
        run = self.begin()
        self.to_the_work(run)
        self.record(run, "do_work", "needs_code", {})
        done = self.walker("next", "--run", run)
        self.assertEqual((done["action"], done["end"]), ("done", "return_late.returned"))
        self.assertEqual(self.ticket.tickets[KEY].status, "Not Started")
        self.assertIn("needs code changes", self.comments()[-1])

    def test_inferred_format_with_no_precedent_asks_before_any_work(self):
        self.ticket.tickets[KEY] = self.ticket.tickets[KEY]._replace(
            description=DESCRIPTION.replace("with the two counts", "with the two counts (inferred)"))
        run = self.begin()
        self.assertEqual(self.walker("next", "--run", run)["step"], "find_precedent")
        self.record(run, "find_precedent", "none", {"candidates": []})
        parked = self.walker("next", "--run", run)
        self.assertEqual((parked["action"], parked["step"]), ("parked", "ping_before"))
        card = json.loads((self.tmp / "questions" / (parked["question_id"] + ".json")).read_text())
        self.assertIn("JP-9001: before I start. Question: How many open widgets", json.dumps(card))


if __name__ == "__main__":
    unittest.main()
