"""JP-114: the JSON copy of each graph, and the walker refusing a graph the checker rejects."""
import json
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

from walker_helpers import ROOT, WalkerCase, compile_graphs, db

BAD = ROOT / "graphs" / "tests" / "fixtures" / "bad"


class Compiling(WalkerCase):
    def test_every_real_graph_has_an_up_to_date_copy(self):
        done = subprocess.run([sys.executable, str(ROOT / "graphs" / "tools" / "compile_graphs.py"), "--check"],
                              stdout=subprocess.PIPE, universal_newlines=True)
        self.assertEqual(done.returncode, 0, done.stdout)

    def test_the_copy_holds_the_graph_the_tiers_and_the_hash_of_every_source(self):
        doc = json.loads((self.root / "compiled" / "valid.json").read_text())
        self.assertEqual(doc["graph"]["graph"], "valid")
        self.assertEqual(doc["max_runs"], {"cheap": 5, "mid": 3, "gate": 2})
        self.assertEqual(doc["roles"]["code-reviewer"]["tier"], "gate")
        self.assertEqual(doc["agents"]["sample-builder"]["fills"], "builder")
        self.assertEqual(sorted(doc["sources"]), ["agents/sample-builder/agent.yaml", "flows/valid.yaml",
                                                  "roles/builder/role.yaml", "roles/code-reviewer/role.yaml",
                                                  "roles/designer/role.yaml", "roles/publisher/role.yaml", "tiers.yaml"])

    def test_a_change_to_a_graph_makes_its_copy_stale_for_the_check_and_for_the_walker(self):
        path = self.root / "flows" / "valid.yaml"
        path.write_text(path.read_text().replace("Sample graph that follows the convention", "Another title"))
        code, out = self.compile_check()
        self.assertEqual(code, 1)
        self.assertIn("valid.json: stale", out)
        refused = self.walker("start", "--graph", "valid", "--ticket", "JP-907", code=2)
        self.assertIn("out of date", refused["error"])
        self.assertEqual(self.compile()[0], 0)                  # rebuilding makes it run again
        self.start()

    def test_a_missing_copy_fails_the_check(self):
        (self.root / "compiled" / "valid.json").unlink()
        code, out = self.compile_check()
        self.assertEqual(code, 1)
        self.assertIn("valid.json: missing", out)

    def compile_check(self):
        done = subprocess.run([sys.executable, str(ROOT / "graphs" / "tools" / "compile_graphs.py"), "--check",
                               "--root", str(self.root)], stdout=subprocess.PIPE, universal_newlines=True)
        return done.returncode, done.stdout


class RefusingARejectedGraph(WalkerCase):
    def test_a_graph_the_checker_refuses_gets_no_copy_and_no_run(self):
        shutil.copy(str(BAD / "loop-without-limit.yaml"), str(self.root / "flows" / "loop-without-limit.yaml"))
        code, out = self.compile()
        self.assertEqual(code, 1)
        self.assertIn("loop-without-limit.yaml", out)
        self.assertFalse((self.root / "compiled" / "loop-without-limit.json").exists())
        refused = self.walker("start", "--graph", "loop-without-limit", "--ticket", "JP-908", code=2)
        self.assertIn("no checked copy", refused["error"])
        conn = db.connect(db.ledger_path())
        self.addCleanup(conn.close)
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM graph_runs").fetchone()[0], 0)

    def test_a_copy_made_by_hand_for_a_rejected_graph_is_refused_by_the_walker_too(self):
        bad = self.root / "flows" / "loop-without-limit.yaml"
        shutil.copy(str(BAD / "loop-without-limit.yaml"), str(bad))
        doc = json.loads((self.root / "compiled" / "valid.json").read_text())
        doc["graph"]["graph"] = "loop-without-limit"
        doc["sources"] = {"flows/loop-without-limit.yaml": compile_graphs.sha256_file(bad)}
        (self.root / "compiled" / "loop-without-limit.json").write_text(json.dumps(doc))
        refused = self.walker("start", "--graph", "loop-without-limit", "--ticket", "JP-909", code=2)
        self.assertIn("checker rejects", refused["error"])

    def test_unknown_and_missing_inputs_are_refused(self):
        self.assertIn("no input 'colour'", self.walker("start", "--graph", "valid", "--ticket", "JP-910", "--input",
                                                       "colour=red", code=2)["error"])
        self.assertIn("not a ticket key", self.walker("start", "--graph", "valid", "--ticket", "nope", code=2)["error"])
        self.assertIn("--ticket", self.walker("start", "--graph", "valid", code=2)["error"])

    def test_a_graph_with_no_ticket_names_its_subject(self):
        out = self.walker("start", "--graph", "valid", "--subject-kind", "intake", "--subject-ref", "email-0001",
                          "--input", "ticket_key=JP-911")
        conn = db.connect(db.ledger_path())
        self.addCleanup(conn.close)
        self.assertEqual(conn.execute("SELECT subject_kind, subject_ref, ticket_key FROM graph_runs WHERE run_id = ?",
                                      (out["run"],)).fetchone(), ("intake", "email-0001", None))


if __name__ == "__main__":
    unittest.main()
