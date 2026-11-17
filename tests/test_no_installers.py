"""JP-119: Josh 360 ships no installers of its own. Its jobs start only through the macbook-automations startup list.

"Installer" here means a launchd job definition: a plist file, or code that writes one. The one exception is the
Session Atlas service installer, which is tracked as transitional in laptop/launchd-register.json and ends at the
phase 1 close (docs/phase-1-close-checklist.md). A new file that touches ~/Library/LaunchAgents has to be added to
USES_LAUNCHAGENTS below with a reason, so the choice is made on purpose.
"""
from __future__ import annotations

import re
import sys
import unittest
from pathlib import Path

from helpers import REPO

sys.path.insert(0, str(REPO / "laptop"))
import check_jobs  # noqa: E402

SKIP_DIRS = {".git", "node_modules", "tests", "docs", "__pycache__"}

# Files that mention ~/Library/LaunchAgents or write a plist, and why. None of them defines a login job of Josh 360's own,
# except the first, which is the tracked exception.
USES_LAUNCHAGENTS = {
    "scripts/atlas_service.py": "TRANSITIONAL: writes the one plist Josh 360 still installs (com.josh360.session-atlas); in the register, ends at the phase 1 close",
    "scripts/retire_leftover_jobs.py": "moves other projects' plists into the archive",
    "scripts/retire_focus_dashboard.py": "moves one old plist into the archive",
    "scripts/retire_session_atlas.py": "moves the old Atlas plist into the archive",
    "scripts/restore_retired_job.py": "moves an archived plist back (the undo)",
    "scripts/laptop_inventory.py": "reads the plists to inventory them",
    "laptop/check_jobs.py": "reads the plists to compare them with the startup list",
}
WRITES_A_PLIST = re.compile(r"plistlib\.dump")


def code_files():
    for path in sorted(REPO.rglob("*")):
        rel = path.relative_to(REPO)
        if not path.is_file() or SKIP_DIRS & set(rel.parts) or path.suffix in (".json", ".png", ".md", ".lock"):
            continue
        if path.name == "package-lock.json":
            continue
        yield rel.as_posix(), path.read_text(encoding="utf-8", errors="ignore")


class NoInstallersTest(unittest.TestCase):

    def test_the_repository_holds_no_login_job_definition(self):
        plists = [p.relative_to(REPO).as_posix() for p in REPO.rglob("*.plist") if "node_modules" not in p.parts
                  and ".git" not in p.parts]
        self.assertEqual(plists, [], "a launchd plist belongs on the macbook-automations startup list, not here")

    def test_only_the_transitional_atlas_installer_writes_a_plist(self):
        writers = [rel for rel, text in code_files() if WRITES_A_PLIST.search(text)]
        self.assertEqual(writers, ["scripts/atlas_service.py"])

    def test_that_installer_is_the_registered_transitional_job(self):
        label = re.search(r'^LABEL = "([^"]+)"', (REPO / "scripts" / "atlas_service.py").read_text(), re.M).group(1)
        row = check_jobs.load_register().transitional_row(label)
        self.assertIsNotNone(row, "the one installer must be named in laptop/launchd-register.json as transitional")
        self.assertIn("scripts/atlas_service.py", row["installed_by"])
        self.assertIn("phase 1 close", row["ends_with"])
        self.assertEqual([r["label"] for r in check_jobs.load_register().transitional], [label])

    def test_every_file_that_touches_launchagents_is_named_here_with_a_reason(self):
        touching = sorted(rel for rel, text in code_files() if "LaunchAgents" in text)
        self.assertEqual(touching, sorted(USES_LAUNCHAGENTS))

    def test_josh_360_jobs_start_only_through_the_job_runner(self):
        """Every job is an entry in jobs.yaml; nothing in jobs.yaml loads a launchd job except the one transitional job."""
        jobs = (REPO / "jobs.yaml").read_text()
        runs = re.findall(r"^    run: (\S+)$", jobs, re.M)
        self.assertGreater(len(runs), 10)
        loaders = [run for run in runs if re.search(r"""["']bootstrap["']|plistlib\.dump""", (REPO / run).read_text())]
        self.assertEqual(loaders, ["scripts/atlas_service.py"])

    def test_the_close_checklist_names_the_step_that_removes_the_installer(self):
        text = (REPO / "docs" / "phase-1-close-checklist.md").read_text()
        self.assertIn("scripts/atlas_service.py", text)
        self.assertIn("com.josh360.session-atlas", text)


if __name__ == "__main__":
    unittest.main()
