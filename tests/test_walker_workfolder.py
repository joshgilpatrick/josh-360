"""The walker's work folder (JP-115): `work/` from the start, the answers file, the order outputs win in, and the
feedback files saved at the end. The graph is the checker's `waits` sample.
Run: python3 -m unittest discover -s tests -t tests -p "test_walker_workfolder.py" -v
"""
import unittest
from pathlib import Path

from walker_helpers import WalkerCase, db, runfolder


class WorkFolder(WalkerCase):
    def start_waits(self):
        return self.start("waits")

    def finish_waits(self, run, answer="blue"):
        self.do_role(run, "zeta", "ready", {"note": "from zeta"})
        self.do_role(run, "alpha", "done", {"note": "from alpha"})
        self.assertEqual(self.walker("next", "--run", run)["step"], "confirm")
        self.answer_in_app(run, "confirm", answer)

    def test_work_folder_exists_from_start(self):
        run = self.start_waits()
        self.assertTrue((self.tmp / "runs" / run / "work").is_dir())
        self.assertEqual(runfolder.work_dir(run), self.tmp / "runs" / run / "work")

    def test_later_output_wins_after_reload(self):
        run = self.start_waits()
        self.finish_waits(run)
        out = self.walker("next", "--run", run)
        self.assertEqual((out["action"], out["step"]), ("run", "tell"), out)
        self.assertEqual(out["inputs"]["note"], "from alpha")

    def test_answers_file_collects_asks_and_answer_outputs(self):
        run = self.start_waits()
        self.finish_waits(run, "use the blue one")
        self.do_role(run, "tell", "told", {"answer": "done as asked"})
        text = (runfolder.work_dir(run) / "answers.md").read_text()
        order = [text.index(part) for part in ("## confirm", "use the blue one", "## tell", "done as asked")]
        self.assertEqual(order, sorted(order), text)

    def test_an_undeclared_gate_answer_is_not_appended(self):
        self.plan({"pr-state": [{"outcome": "merged", "outputs": {"answer": "merged by hand"}}]})
        run = self.start_waits()
        self.do_role(run, "zeta", "ready", {"note": "a"})
        self.do_role(run, "alpha", "done", {"note": "b"})
        self.walker("next", "--run", run)
        # the sample wait declares only `state`, so an undeclared `answer` is not kept and not appended
        self.assertFalse((runfolder.work_dir(run) / "answers.md").exists())

    def test_feedback_files_are_saved_at_the_end(self):
        run = self.start_waits()
        work = runfolder.work_dir(run)
        (work / "feedback").mkdir()
        (work / "hardening.md").write_text("a made-up finding\n")
        (work / "feedback" / "p1.md").write_text("a made-up failing check\n")
        self.finish_waits(run)
        self.do_role(run, "tell", "told", {"answer": "ok"})
        self.assertEqual(self.walker("next", "--run", run)["action"], "done")
        saved = sorted(p.name for p in (self.tmp / "runs" / run / "saved").iterdir())
        self.assertEqual(len(saved), 2, saved)
        self.assertTrue(any("hardening" in n for n in saved) and any("p1" in n for n in saved), saved)
        conn = db.connect(db.ledger_path())
        self.addCleanup(conn.close)
        rows = conn.execute("SELECT kind, name, sha256, step_run_id FROM run_files").fetchall()
        self.assertEqual(sorted(r[1] for r in rows), ["hardening", "p1"])
        self.assertTrue(all(r[0] == "feedback" and len(r[2]) == 64 and r[3] is None for r in rows), rows)


if __name__ == "__main__":
    unittest.main()
