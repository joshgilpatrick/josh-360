"""The documentation checks (scripts/docs_check.py, JP-158), on made-up repositories in temporary folders."""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import docs_check  # noqa: E402

SKILL_MD = """---
name: verify-josh-360
description: "Drive Josh 360: its hooks, background jobs, ledger, platform doctor and graph walker."
---

# Verify

## Launch

Run it.

## Doctor

Check it.

## Drive

Drive it.

## Evidence

Keep it.

## Cleanup

Clean it.
"""

FEATURE = """# A feature

## Sub-features

One.

## How to get to it (user POV)

Here.

## Driving it with sandbox.py

Like this.

## Gotchas

None.
"""


class DocsCheckTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.write("README.md", "# Repo\n\nWhat it is.\n")
        self.write("docs/README.md", "# Docs\n\nThe docs.\n\n## Contents\n\n- [Part](#part)\n\n## Part\n\nText.\n")
        self.write("graphs/README.md", "# Graphs\n\nThe graphs.\n")
        self.write("graphs/roles/README.md", "# Roles\n\n| builder | builds |\n")
        self.write("graphs/roles/builder/role.yaml", "id: builder\n")
        self.write("graphs/agents/README.md", "# Agents\n\n| finder | finds |\n")
        self.write("graphs/agents/finder/agent.yaml", "id: finder\n")
        skill = ".claude/skills/verify-josh-360"
        self.write(f"{skill}/SKILL.md", SKILL_MD)
        self.write(f"{skill}/scripts/sandbox.py", "#!/usr/bin/env python3\nprint('ok')\n")
        os.chmod(self.root / skill / "scripts/sandbox.py", 0o755)
        self.write(f"{skill}/features/README.md", "# Features\n\n- [A feature](a-feature.md)\n")
        self.write(f"{skill}/features/a-feature.md", FEATURE)

    def tearDown(self):
        self._tmp.cleanup()

    def write(self, rel: str, text: str) -> None:
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def problems(self) -> list[str]:
        return docs_check.problems(self.root)

    def test_clean_repo_passes(self):
        self.assertEqual(self.problems(), [])

    def test_broken_links_and_anchors_fail(self):
        self.write("docs/a.md", "# A\n\nText.\n\n[gone](missing.md) [here](#nope) [there](README.md#part) "
                                "[bad](README.md#nothing) [web](https://example.com) [up](../README.md)\n")
        found = self.problems()
        self.assertEqual(sorted(found), sorted([
            "broken link: docs/a.md: missing.md",
            "broken anchor: docs/a.md: #nope",
            "broken anchor: docs/a.md: README.md#nothing",
        ]))

    def test_links_in_code_are_not_checked(self):
        self.write("docs/a.md", "# A\n\nText `[x](missing.md)`.\n\n```\n[y](missing.md)\n```\n")
        self.assertEqual(self.problems(), [])

    def test_fixtures_are_skipped(self):
        self.write("graphs/tests/fixtures/bad.md", "# Bad\n\nText.\n\n[gone](missing.md)\n")
        self.assertEqual(self.problems(), [])

    def test_folder_without_readme_fails(self):
        self.write("ledger/record.py", "")
        self.assertIn("top-level folder has no README.md: ledger/", self.problems())

    def test_readme_without_a_paragraph_fails(self):
        self.write("ledger/README.md", "# Ledger\n\n## Contents\n")
        self.assertEqual(len(self.problems()), 1)
        self.assertIn("ledger/", self.problems()[0])

    def test_hidden_folders_need_no_readme(self):
        self.write(".github/workflows/test.yml", "on: push\n")
        self.assertEqual(self.problems(), [])

    def test_unlisted_role_fails(self):
        self.write("graphs/roles/hardener/role.yaml", "id: hardener\n")
        self.assertEqual(self.problems(), ["graphs/roles/README.md does not name hardener"])

    def test_skill_shape(self):
        skill = self.root / ".claude/skills/verify-josh-360/SKILL.md"
        text = SKILL_MD.replace("name: verify-josh-360", "name: verify").replace("## Evidence", "## Proof")
        skill.write_text(text + "\nTODO: finish\n", encoding="utf-8")
        found = " ".join(self.problems())
        self.assertIn("frontmatter name", found)
        self.assertIn("'## Evidence'", found)
        self.assertIn("placeholder left", found)

    def test_description_must_name_the_surfaces(self):
        skill = self.root / ".claude/skills/verify-josh-360/SKILL.md"
        skill.write_text(SKILL_MD.replace("ledger, platform doctor and graph walker", "things"), encoding="utf-8")
        self.assertEqual(len(self.problems()), 1)
        self.assertIn("ledger, doctor, walker", self.problems()[0])

    def test_sandbox_must_be_executable(self):
        os.chmod(self.root / ".claude/skills/verify-josh-360/scripts/sandbox.py", 0o644)
        self.assertEqual(self.problems(), ["not executable: .claude/skills/verify-josh-360/scripts/sandbox.py"])

    def test_feature_sections_must_match(self):
        self.write(".claude/skills/verify-josh-360/features/a-feature.md",
                   FEATURE.replace("## Gotchas", "## Contents\n\nx\n\n## Gotchas"))
        self.assertEqual(len(self.problems()), 1)
        self.assertIn("sections must be exactly", self.problems()[0])

    def test_driving_section_must_name_the_harness(self):
        self.write(".claude/skills/verify-josh-360/features/a-feature.md",
                   FEATURE.replace("Driving it with sandbox.py", "Driving it with"))
        self.assertEqual(len(self.problems()), 1)

    def test_unindexed_feature_fails(self):
        self.write(".claude/skills/verify-josh-360/features/b-feature.md", FEATURE)
        self.assertEqual(self.problems(),
                         [".claude/skills/verify-josh-360/features/README.md does not link to b-feature.md"])

    def test_real_repository_passes(self):
        self.assertEqual(docs_check.problems(), [])


if __name__ == "__main__":
    unittest.main()
