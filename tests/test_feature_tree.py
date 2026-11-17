"""Tests for scripts/feature_tree.py and the JP-143 feature tree.

Each test named after a Gherkin scenario in JP-143 proves that scenario. Run: python3 -m unittest discover -s tests
"""
from __future__ import annotations

import copy
import json
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import feature_tree  # noqa: E402

# Made-up sample data, shaped like the real tree.
SAMPLE = {
    "homes": {"sessions": {"name": "Sessions", "about": "Sample"}},
    "tree": [{
        "id": "R", "name": "Sample repo", "children": [{
            "id": "R.area", "name": "Sample area", "children": [
                {"id": "X1", "name": "Kept thing", "what": "Does a thing.", "call": "keep", "how": "as-is",
                 "home": "sessions", "why": "Used daily.", "children": [
                     {"id": "X1.1", "name": "Old copy", "what": "A second copy.", "call": "drop", "how": "merged",
                      "into": "X1", "why": "One copy survives."}]},
                {"id": "X2", "name": "Retired thing", "what": "Does nothing now.", "call": "drop", "how": "retire",
                 "why": "Nothing uses it."},
            ]}]}],
}


def sample_problems(data):
    saved = feature_tree.REQUIRED_IDS
    feature_tree.REQUIRED_IDS = []
    try:
        return feature_tree.problems(data)
    finally:
        feature_tree.REQUIRED_IDS = saved


class EveryFeatureHasACallAndARationale(unittest.TestCase):
    def test_the_real_tree_has_no_problems(self):
        self.assertEqual(feature_tree.problems(feature_tree.load()), [])

    def test_the_sample_tree_has_no_problems(self):
        self.assertEqual(sample_problems(SAMPLE), [])

    def test_a_feature_with_no_rationale_is_refused(self):
        data = copy.deepcopy(SAMPLE)
        data["tree"][0]["children"][0]["children"][1]["why"] = " "
        self.assertIn("X2: no why", sample_problems(data))

    def test_a_call_other_than_keep_or_drop_is_refused(self):
        data = copy.deepcopy(SAMPLE)
        data["tree"][0]["children"][0]["children"][1]["call"] = "maybe"
        self.assertIn("X2: call must be keep or drop, not 'maybe'", sample_problems(data))

    def test_a_repeated_id_is_refused(self):
        data = copy.deepcopy(SAMPLE)
        data["tree"][0]["children"][0]["children"][1]["id"] = "X1"
        self.assertIn("X1: id used 2 times", sample_problems(data))

    def test_a_kept_feature_needs_a_known_home(self):
        data = copy.deepcopy(SAMPLE)
        data["tree"][0]["children"][0]["children"][0]["home"] = "nowhere"
        self.assertIn("X1: home 'nowhere' is not one of the homes", sample_problems(data))

    def test_a_merge_must_name_a_node_in_the_tree(self):
        data = copy.deepcopy(SAMPLE)
        data["tree"][0]["children"][0]["children"][0]["children"][0]["into"] = "Z9"
        self.assertIn("X1.1: merged into 'Z9', which is not in the tree", sample_problems(data))

    def test_how_must_match_the_call(self):
        data = copy.deepcopy(SAMPLE)
        data["tree"][0]["children"][0]["children"][1]["how"] = "rebuilt"
        self.assertTrue(any(p.startswith("X2: how must be one of") for p in sample_problems(data)))

    def test_every_real_feature_id_is_a_valid_page_id(self):
        for node, _ in feature_tree.walk(feature_tree.load()["tree"]):
            self.assertRegex(node["id"], r"^[A-Za-z0-9.]+$")


class EveryExistingFeatureRowIsCovered(unittest.TestCase):
    def test_every_features_md_row_is_in_the_tree(self):
        text = (ROOT / "docs/inventory/features.md").read_text(encoding="utf-8")
        rows = set(re.findall(r"^\| ([AS]\d+) \|", text, flags=re.M))
        self.assertEqual(len(rows), 51)
        ids = {n["id"] for n, _ in feature_tree.walk(feature_tree.load()["tree"])}
        self.assertEqual(rows - ids, set())

    def test_a_missing_row_is_reported(self):
        self.assertIn("A1: a features.md row missing from the tree", feature_tree.problems(SAMPLE))


class ThePageIsBuiltFromTheTree(unittest.TestCase):
    def test_the_committed_page_is_up_to_date(self):
        data = feature_tree.load()
        page = feature_tree.render(data, feature_tree.TEMPLATE.read_text(encoding="utf-8"))
        self.assertEqual(feature_tree.PAGE.read_text(encoding="utf-8"), page,
                         "run python3 scripts/feature_tree.py build")

    def test_the_page_embeds_every_node_and_cannot_close_its_script(self):
        data = copy.deepcopy(SAMPLE)
        data["tree"][0]["children"][0]["children"][1]["why"] = "a </script> inside text"
        page = feature_tree.render(data, "<script>const DATA = /*__DATA__*/null;</script>")
        self.assertEqual(page.count("</script>"), 1)
        blob = page[len("<script>const DATA = "):-len(";</script>")]
        self.assertEqual(json.loads(blob)["tree"][0]["children"][0]["children"][1]["why"], "a </script> inside text")

    def test_the_page_saves_to_the_review_document(self):
        template = feature_tree.TEMPLATE.read_text(encoding="utf-8")
        self.assertIn('const DOC = "reviews/featureTree"', template)
        self.assertIn('claude.use("db")', template)


if __name__ == "__main__":
    unittest.main()
