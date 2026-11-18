"""JP-160: jobs.yaml reads the same with a standard YAML reader as with the laptop's strict reader.

The laptop reads the file with laptop/common.py (standard library only). Agents and tools read it with
yaml.safe_load. scripts/check.py's jobs_yaml_problems keeps the two in step.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "laptop"))
import check  # noqa: E402
import common  # noqa: E402

GOOD = "jobs:\n  - id: follow\n    run: laptop/follow.py\n    every: 10m\n"


def with_description(value: str) -> str:
    return GOOD + "    description: " + value + "\n"


class RealFileTest(unittest.TestCase):

    def test_safe_load_reads_the_real_file(self):
        data = yaml.safe_load((ROOT / "jobs.yaml").read_text(encoding="utf-8"))
        self.assertEqual(list(data), ["jobs"])

    def test_both_readers_give_the_same_jobs(self):
        text = (ROOT / "jobs.yaml").read_text(encoding="utf-8")
        from_yaml = check.yaml_jobs(yaml.safe_load(text))
        self.assertEqual(from_yaml, common.parse_jobs_text(text))
        self.assertEqual(common.validate_jobs(from_yaml, ROOT), common.load_jobs(ROOT))

    def test_the_check_passes_on_the_real_file(self):
        self.assertEqual(check.jobs_yaml_problems((ROOT / "jobs.yaml").read_text(encoding="utf-8")), [])


class StrictReaderQuotesTest(unittest.TestCase):

    def description(self, value: str) -> str:
        return common.parse_jobs_text(with_description(value))[0]["description"]

    def test_double_quotes_hold_a_colon(self):
        self.assertEqual(self.description('"JP-113: one call"'), "JP-113: one call")

    def test_single_quotes_double_a_quote(self):
        self.assertEqual(self.description("'the laptop''s copy: main'"), "the laptop's copy: main")

    def test_refuses_what_yaml_would_read_differently(self):
        for value in ('"a \\" b"', '"C:\\\\temp"', '"one" and "two"', "'one' and 'two'", "'it's'"):
            with self.subTest(value), self.assertRaises(common.Unexpected):
                self.description(value)

    def test_each_accepted_quoted_value_matches_yaml(self):
        for value in ('"JP-113: one call"', "'the laptop''s copy: main'", "'#1 job'", '"x # not a comment"'):
            with self.subTest(value):
                text = with_description(value)
                self.assertEqual(common.parse_jobs_text(text)[0]["description"],
                                 yaml.safe_load(text)["jobs"][0]["description"])


class CheckTest(unittest.TestCase):

    def test_quoted_colon_passes(self):
        self.assertEqual(check.jobs_yaml_problems(with_description('"JP-113: one call"')), [])

    def test_unquoted_colon_fails(self):
        problems = check.jobs_yaml_problems(with_description("JP-113: one call"))
        self.assertEqual(len(problems), 1)
        self.assertIn("standard YAML reader", problems[0])

    def test_a_value_yaml_reads_as_another_type_fails(self):
        for value in ("yes", "12", "null", "2026-11-18"):
            with self.subTest(value):
                problems = check.jobs_yaml_problems(with_description(value))
                self.assertEqual(len(problems), 1)
                self.assertIn("quote it", problems[0])

    def test_report_true_is_the_same_for_both(self):
        self.assertEqual(check.jobs_yaml_problems(GOOD + "    report: true\n"), [])

    def test_the_strict_reader_refusing_fails(self):
        problems = check.jobs_yaml_problems(GOOD + "    colour: red\n")
        self.assertEqual(len(problems), 1)
        self.assertIn("laptop's reader", problems[0])


if __name__ == "__main__":
    unittest.main()
