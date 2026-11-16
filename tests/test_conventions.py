"""Tests for scripts/conventions.py and the files in conventions/ (JP-98).

Each test named after a Gherkin scenario in JP-98 proves that scenario. Run: python3 -m unittest discover -s tests
"""
from __future__ import annotations

import copy
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import conventions  # noqa: E402

HOME = "/Users/sample"

# Made-up sample data: none of these systems, folders or keys is real.
SAMPLE_REGISTRY = {
    "version": 1,
    "fallback": {"jira_space": "JP", "priority": "unassigned"},
    "spaces": {"JP": "Personal intake", "AD": "Apps", "TECH": "Initiatives only"},
    "areas": {"Sample area": "Sample team", "DevEx area": "Sample team"},
    "systems": [
        {
            "name": "sample-app",
            "description": "A sample app",
            "repositories": ["sample-app"],
            "folders": ["~/Development/active/sample-app"],
            "area": "Sample area",
            "tracker": "jira",
            "jira_space": "AD",
            "default_epic": "AD-1",
            "priority": "athena",
        },
        {
            "name": "sample-monorepo",
            "description": "A folder that holds another system",
            "repositories": ["sample-monorepo"],
            "folders": ["~/Development/active/sample-monorepo"],
            "area": "DevEx area",
            "tracker": "jira",
            "jira_space": "JP",
            "default_epic": None,
            "priority": "devex",
        },
        {
            "name": "sample-nested",
            "description": "A system inside sample-monorepo",
            "repositories": ["sample-nested"],
            "folders": ["~/Development/active/sample-monorepo/sample-nested"],
            "area": "DevEx area",
            "tracker": "jira",
            "jira_space": "JP",
            "default_epic": "JP-2",
            "priority": "devex",
        },
        {
            "name": "sample-personal",
            "description": "A personal system",
            "repositories": ["sample-personal"],
            "folders": ["~/development/personal/sample-personal"],
            "area": None,
            "tracker": "linear",
            "linear_team": "GIL",
            "priority": "unassigned",
        },
    ],
}

STANDING = ["athena", "equip", "pims", "ma-clinical-data-transfer", "clinician-tech-stack-ux", "ai-scribing-utilization"]

SAMPLE_PRIORITIES = {
    "version": 1,
    "priorities": [
        {"id": pid, "name": pid.title(), "kind": "standing", "rank": n,
         "covers": {"areas": [], "initiatives": [], "epics": []}}
        for n, pid in enumerate(STANDING, 1)
    ] + [
        {"id": "devex", "name": "DevEx", "kind": "devex", "covers": {"areas": ["DevEx area"], "initiatives": [], "epics": ["JP-2"]}},
        {"id": "unassigned", "name": "Unassigned", "kind": "unassigned", "covers": {"areas": [], "initiatives": [], "epics": []}},
    ],
}
SAMPLE_PRIORITIES["priorities"][0]["covers"] = {"areas": ["Sample area"], "initiatives": ["TECH-1"], "epics": ["AD-1"]}


def problems(registry=None, priorities=None):
    return conventions.validate(registry or SAMPLE_REGISTRY, priorities or SAMPLE_PRIORITIES)


class AKnownFolderResolves(unittest.TestCase):
    """Scenario: A known folder resolves."""

    def test_a_known_folder_resolves(self):
        answer = conventions.lookup_folder(SAMPLE_REGISTRY, f"{HOME}/Development/active/sample-app", home=HOME)
        self.assertEqual(answer["system"], "sample-app")
        self.assertEqual(answer["area"], "Sample area")
        self.assertEqual(answer["jira_space"], "AD")
        self.assertEqual(answer["priority"], "athena")
        self.assertEqual(answer["default_epic"], "AD-1")

    def test_a_subfolder_of_a_known_folder_resolves(self):
        answer = conventions.lookup_folder(SAMPLE_REGISTRY, f"{HOME}/Development/active/sample-app/src/deep", home=HOME)
        self.assertEqual(answer["system"], "sample-app")

    def test_the_most_specific_folder_wins(self):
        answer = conventions.lookup_folder(
            SAMPLE_REGISTRY, f"{HOME}/Development/active/sample-monorepo/sample-nested/x", home=HOME)
        self.assertEqual(answer["system"], "sample-nested")
        answer = conventions.lookup_folder(SAMPLE_REGISTRY, f"{HOME}/Development/active/sample-monorepo/other", home=HOME)
        self.assertEqual(answer["system"], "sample-monorepo")

    def test_a_linear_system_names_its_team_not_a_jira_space(self):
        answer = conventions.lookup_folder(SAMPLE_REGISTRY, f"{HOME}/development/personal/sample-personal", home=HOME)
        self.assertEqual(answer["tracker"], "linear")
        self.assertEqual(answer["linear_team"], "GIL")
        self.assertIsNone(answer["jira_space"])

    def test_a_known_repository_resolves(self):
        answer = conventions.lookup_repo(SAMPLE_REGISTRY, "some-org/sample-app")
        self.assertEqual(answer["system"], "sample-app")
        self.assertEqual(conventions.lookup_repo(SAMPLE_REGISTRY, "SAMPLE-APP.git")["system"], "sample-app")
        self.assertEqual(conventions.lookup_repo(SAMPLE_REGISTRY, "git@github.com:org/sample_app.git")["system"],
                         "sample-app")

    def test_every_real_registry_folder_resolves_to_its_own_system(self):
        registry = conventions.load(conventions.REGISTRY)
        for system in registry["systems"]:
            for folder in system.get("folders") or []:
                answer = conventions.lookup_folder(registry, folder, home=HOME)
                self.assertEqual(answer["system"], system["name"], folder)
                self.assertTrue(answer["priority"], folder)
                if system["tracker"] == "jira":
                    self.assertTrue(answer["jira_space"], folder)
                    self.assertTrue(answer["area"], folder)

    def test_the_cli_prints_the_answer_as_json(self):
        out = io.StringIO()
        with redirect_stdout(out):
            code = conventions.main(["lookup", "--folder", "~/Development/active/josh_360/.claude/worktrees/x", "--home", HOME])
        self.assertEqual(code, 0)
        answer = json.loads(out.getvalue())
        self.assertEqual(answer["system"], "josh-360")
        self.assertEqual(answer["jira_space"], "JP")
        self.assertEqual(answer["priority"], "devex")


class AnUnknownFolderStaysUnassigned(unittest.TestCase):
    """Scenario: An unknown folder stays Unassigned."""

    def assert_unassigned(self, answer):
        self.assertEqual(answer["priority"], "unassigned")
        self.assertIsNone(answer["system"])
        self.assertIsNone(answer["area"])
        self.assertIsNone(answer["default_epic"])
        self.assertEqual(answer["jira_space"], "JP")  # the fallback space for a ticket, not a guess at a system
        self.assertTrue(answer["unassigned"])

    def test_an_unknown_folder_stays_unassigned(self):
        self.assert_unassigned(conventions.lookup_folder(SAMPLE_REGISTRY, f"{HOME}/Downloads/something", home=HOME))

    def test_nothing_is_guessed_from_a_similar_name(self):
        # Shares a prefix and most of a name with a known folder, but is not inside it.
        for folder in (f"{HOME}/Development/active/sample-app-old",
                       f"{HOME}/Development/active/sample",
                       f"{HOME}/Development/active",
                       "/elsewhere/Development/active/sample-app"):
            with self.subTest(folder=folder):
                self.assert_unassigned(conventions.lookup_folder(SAMPLE_REGISTRY, folder, home=HOME))

    def test_an_unknown_repository_stays_unassigned(self):
        self.assert_unassigned(conventions.lookup_repo(SAMPLE_REGISTRY, "some-org/sample-app-fork"))

    def test_the_cli_says_unassigned_and_exits_zero(self):
        out = io.StringIO()
        with redirect_stdout(out):
            code = conventions.main(["lookup", "--folder", "/tmp/not-a-system", "--home", HOME])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out.getvalue())["priority"], "unassigned")


class TheCheckerRefusesABadRegistry(unittest.TestCase):
    """Scenario: The checker refuses a bad registry."""

    def test_the_sample_files_pass(self):
        self.assertEqual(problems(), [])

    def test_the_real_files_pass(self):
        self.assertEqual(conventions.validate(conventions.load(conventions.REGISTRY),
                                              conventions.load(conventions.PRIORITIES)), [])

    def test_the_checker_refuses_a_bad_registry(self):
        bad = copy.deepcopy(SAMPLE_REGISTRY)
        del bad["systems"][0]["jira_space"]
        found = problems(registry=bad)
        self.assertTrue(any("sample-app" in p and "jira_space" in p for p in found), found)

    def test_the_cli_exits_with_an_error_that_names_the_entry(self):
        bad = copy.deepcopy(SAMPLE_REGISTRY)
        bad["systems"][1]["jira_space"] = ""
        with tempfile.TemporaryDirectory() as tmp:
            reg = Path(tmp) / "registry.yaml"
            pri = Path(tmp) / "priorities.yaml"
            reg.write_text(yaml.safe_dump(bad), encoding="utf-8")
            pri.write_text(yaml.safe_dump(SAMPLE_PRIORITIES), encoding="utf-8")
            out = io.StringIO()
            with redirect_stdout(out):
                code = conventions.main(["check", "--registry", str(reg), "--priorities", str(pri)])
        self.assertEqual(code, 1)
        self.assertIn("sample-monorepo", out.getvalue())
        self.assertIn("jira_space", out.getvalue())

    def refused(self, mutate, *words, target="registry"):
        reg, pri = copy.deepcopy(SAMPLE_REGISTRY), copy.deepcopy(SAMPLE_PRIORITIES)
        mutate(reg if target == "registry" else pri)
        found = problems(reg, pri)
        self.assertTrue(any(all(w in p for w in words) for p in found), (words, found))

    def test_other_bad_registries_are_refused_by_name(self):
        def unknown_space(r): r["systems"][0]["jira_space"] = "ZZ"
        def tech_space(r): r["systems"][0]["jira_space"] = "TECH"
        def unknown_priority(r): r["systems"][0]["priority"] = "nope"
        def unknown_area(r): r["systems"][0]["area"] = "Nowhere"
        def epic_in_other_space(r): r["systems"][0]["default_epic"] = "JP-9"
        def duplicate_folder(r): r["systems"][1]["folders"] = list(r["systems"][0]["folders"])
        def duplicate_name(r): r["systems"][1]["name"] = "sample-app"
        def duplicate_repo(r): r["systems"][1]["repositories"] = ["Sample-App"]
        def no_linear_team(r): del r["systems"][3]["linear_team"]
        def label_not_lowercase(r): r["systems"][0]["name"] = "Sample-App"
        def unknown_key(r): r["systems"][0]["jira_spcae"] = "AD"
        def relative_folder(r): r["systems"][0]["folders"] = ["Development/active/sample-app"]
        def bad_fallback(r): r["fallback"]["jira_space"] = "ZZ"
        def area_disagrees(r): r["systems"][0]["area"] = "DevEx area"
        def repos_and_folders_missing(r): r["systems"][0]["repositories"] = r["systems"][0]["folders"] = []
        self.refused(unknown_space, "sample-app", "jira_space", "ZZ")
        self.refused(tech_space, "sample-app", "TECH")
        self.refused(unknown_priority, "sample-app", "priority", "nope")
        self.refused(unknown_area, "sample-app", "area", "Nowhere")
        self.refused(epic_in_other_space, "sample-app", "default_epic", "JP-9")
        self.refused(duplicate_folder, "sample-monorepo", "folder")
        self.refused(duplicate_name, "sample-app", "more than once")
        self.refused(duplicate_repo, "sample-monorepo", "repositor")
        self.refused(no_linear_team, "sample-personal", "linear_team")
        self.refused(label_not_lowercase, "Sample-App", "lowercase")
        self.refused(unknown_key, "sample-app", "jira_spcae")
        self.refused(relative_folder, "sample-app", "folder")
        self.refused(bad_fallback, "fallback", "ZZ")
        self.refused(area_disagrees, "sample-app", "disagrees", "devex")
        self.refused(repos_and_folders_missing, "sample-app", "nothing can resolve")

    def test_bad_priorities_files_are_refused_by_name(self):
        def missing_standing(p): p["priorities"] = [x for x in p["priorities"] if x["id"] != "pims"]
        def no_unassigned(p): p["priorities"] = [x for x in p["priorities"] if x["id"] != "unassigned"]
        def unassigned_covers(p): p["priorities"][-1]["covers"]["epics"] = ["AD-5"]
        def claimed_twice(p): p["priorities"][1]["covers"]["epics"] = ["AD-1"]
        def bad_key(p): p["priorities"][0]["covers"]["initiatives"] = ["tech 1"]
        def area_unknown(p): p["priorities"][2]["covers"]["areas"] = ["Nowhere"]
        def seventh_standing(p): p["priorities"].append(
            {"id": "extra", "name": "Extra", "kind": "standing", "rank": 7, "covers": {}})
        self.refused(missing_standing, "pims", target="priorities")
        self.refused(no_unassigned, "unassigned", target="priorities")
        self.refused(unassigned_covers, "unassigned", "covers", target="priorities")
        self.refused(claimed_twice, "AD-1", "equip", target="priorities")
        self.refused(bad_key, "athena", "tech 1", target="priorities")
        self.refused(area_unknown, "pims", "Nowhere", target="priorities")
        self.refused(seventh_standing, "extra", target="priorities")


class PriorityFromJiraLinks(unittest.TestCase):
    """A ticket's epic, initiative or area gives its priority; anything else is Unassigned."""

    def test_the_most_specific_link_wins(self):
        self.assertEqual(conventions.priority_for(SAMPLE_PRIORITIES, epic="AD-1"), "athena")
        self.assertEqual(conventions.priority_for(SAMPLE_PRIORITIES, epic="JP-2", area="Sample area"), "devex")
        self.assertEqual(conventions.priority_for(SAMPLE_PRIORITIES, initiative="TECH-1"), "athena")
        self.assertEqual(conventions.priority_for(SAMPLE_PRIORITIES, area="DevEx area"), "devex")

    def test_unknown_links_stay_unassigned(self):
        self.assertEqual(conventions.priority_for(SAMPLE_PRIORITIES, epic="AD-999", area="Elsewhere"), "unassigned")
        self.assertEqual(conventions.priority_for(SAMPLE_PRIORITIES), "unassigned")


class TheReadyRuleIsWrittenDown(unittest.TestCase):
    """Scenario: The Ready rule is written down."""

    def test_the_ready_rule_is_written_down(self):
        text = (ROOT / "conventions/tickets.md").read_text(encoding="utf-8")
        self.assertIn("A Ready ticket has no open questions for Josh.", text)
        self.assertIn("The one exception is a ticket whose purpose is to produce a spec, a design or a plan", text)


if __name__ == "__main__":
    unittest.main()
