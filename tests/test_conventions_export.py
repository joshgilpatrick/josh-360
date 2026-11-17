"""JP-107, Task 4: the JSON copies of the conventions files, for code that has no YAML reader."""
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "conventions.py"


def run(*args):
    return subprocess.run([sys.executable, str(SCRIPT)] + list(args), cwd=str(ROOT), stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, universal_newlines=True,
                          env={"PATH": "/usr/bin:/bin:/usr/local/bin", "PYTHONDONTWRITEBYTECODE": "1"})


class ExportJson(unittest.TestCase):
    def test_export_json_matches_yaml(self):
        import yaml
        for name in ("registry", "priorities"):
            copy = json.loads((ROOT / "conventions" / (name + ".json")).read_text(encoding="utf-8"))
            source = yaml.safe_load((ROOT / "conventions" / (name + ".yaml")).read_text(encoding="utf-8"))
            self.assertEqual(copy, source, name)

    def test_the_committed_copies_are_fresh(self):
        result = run("export-json", "--check")
        self.assertEqual(result.returncode, 0, result.stdout)

    def test_check_fails_when_json_is_stale(self):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, str(tmp), True)
        for name in ("registry", "priorities"):
            shutil.copy(str(ROOT / "conventions" / (name + ".yaml")), str(tmp / (name + ".yaml")))
        args = ["--registry", str(tmp / "registry.yaml"), "--priorities", str(tmp / "priorities.yaml")]
        missing = run(*args, "export-json", "--check")
        self.assertEqual(missing.returncode, 1)
        self.assertIn("registry.json: out of date", missing.stdout)
        self.assertEqual(run(*args, "export-json").returncode, 0)
        self.assertEqual(run(*args, "export-json", "--check").returncode, 0)
        (tmp / "registry.yaml").write_text((tmp / "registry.yaml").read_text() + "\n# a comment\nextra_key: 1\n")
        stale = run(*args, "export-json", "--check")
        self.assertEqual(stale.returncode, 1)
        self.assertFalse(stale.stdout.count("priorities.json"))

    def test_check_writes_nothing(self):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, str(tmp), True)
        shutil.copy(str(ROOT / "conventions" / "registry.yaml"), str(tmp / "registry.yaml"))
        shutil.copy(str(ROOT / "conventions" / "priorities.yaml"), str(tmp / "priorities.yaml"))
        run("--registry", str(tmp / "registry.yaml"), "--priorities", str(tmp / "priorities.yaml"), "export-json", "--check")
        self.assertEqual(sorted(p.name for p in tmp.iterdir()), ["priorities.yaml", "registry.yaml"])

    def test_lookup_works_without_yaml(self):
        code = ("import sys, json; sys.modules['yaml'] = None; sys.path.insert(0, 'scripts'); import conventions; "
                "r = json.load(open('conventions/registry.json')); "
                "p = json.load(open('conventions/priorities.json')); "
                "print(conventions.lookup_repo(r, 'josh-360')['jira_space'], conventions.priority_for(p, 'AD-198'))")
        result = subprocess.run([sys.executable, "-c", code], cwd=str(ROOT), stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, universal_newlines=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.split(), ["JP", "equip"])


if __name__ == "__main__":
    unittest.main()
