"""JP-165, Task 1: the Validation section parser and the collector list. Made-up tickets only.

Run: python3 -m unittest discover -s graphs/tests -p "test_validation_section.py"   (from the repository root)
"""
from __future__ import annotations

import unittest
from pathlib import Path

import ticket_creation_helpers as h  # noqa: F401  (puts graphs/gates on sys.path)

from lib import dev_spec, validation_section as vs
from lib.collectors import COMPARISONS, DECLARED
from lib.ticket_text import parse_sections

ROOT = Path(__file__).resolve().parent.parent.parent

YES = """**Validation:**

- Needed: yes
- Starts: at Deployed
- Check every: 1 day
- Complete when: 7 checks in a row pass
- Give up after: 21 days

```gherkin
@validate
Scenario: The retirement job runs clean
  When the watch reads job retire-session-atlas
  Then last_exit is 0
  And hours_since_run is at most 2

@validate
Scenario: The doctor reports no failed check
  When the watch reads report doctor summary.fail
  Then value is 0
```
"""

EVENTS = """**Validation:**

- Needed: yes
- Starts: at Deployed
- Check every: 1 day
- Complete when: after 20 events
- Give up after: 30 days

```gherkin
@validate
Scenario: Forwarded emails end with a signed-off deliverable
  When the watch reads ledger-runs non-development
  Then needs_josh is at most 1
```
"""

NO = """**Validation:**

- Needed: no. The change is a document; nothing runs in production.
"""

FIRST_CRITERION = {"id": "V1", "name": "The retirement job runs clean", "collector": "job",
                   "argument": "retire-session-atlas",
                   "checks": [{"field": "last_exit", "comparison": "is", "value": 0},
                              {"field": "hours_since_run", "comparison": "is at most", "value": 2}],
                   "manual": False, "statement": ""}


def desc(validation, goal="Stop the retirement job failing."):
    """A ticket description in marked text: Goal, Acceptance criteria, the given Validation text, Repository."""
    return ("**Goal:** " + goal + "\n\n**Acceptance criteria:**\n\n```gherkin\nFeature: Retirement\n  @auto\n"
            "  Scenario: The job exits clean\n    Given the job has run\n    When it ends\n    Then it exits 0\n```\n\n"
            + validation + "\n**Repository:** josh-360\n")


def items(text, key=""):
    return [p["item"] for p in vs.parse(desc(text), key)["problems"]]


class Reading(unittest.TestCase):
    def test_first_example_reads(self):
        got = vs.parse(desc(YES))
        self.assertEqual(got["needed"], "yes")
        self.assertEqual(len(got["criteria"]), 2)
        self.assertEqual(got["check_every_hours"], 24)
        self.assertEqual((got["complete_kind"], got["complete_n"]), ("streak", 7))
        self.assertEqual((got["give_up_days"], got["fail_after"]), (21, 3))
        self.assertEqual(got["starts_kind"], "deployed")
        self.assertEqual(got["problems"], [])
        self.assertEqual(got["criteria"][0], FIRST_CRITERION)
        self.assertEqual(got["criteria"][1]["id"], "V2")

    def test_events_example_reads(self):
        got = vs.parse(desc(EVENTS))
        self.assertEqual((got["complete_kind"], got["complete_n"]), ("events", 20))
        self.assertEqual(len(got["criteria"]), 1)
        self.assertEqual(got["criteria"][0]["collector"], "ledger-runs")
        self.assertEqual(got["criteria"][0]["argument"], "non-development")
        self.assertEqual(got["problems"], [])

    def test_needed_no_reads_its_reason(self):
        got = vs.parse(desc(NO))
        self.assertEqual(got["needed"], "no")
        self.assertEqual(got["reason"], "The change is a document; nothing runs in production.")
        self.assertEqual(vs.route(got), "not_needed")
        self.assertEqual(got["problems"], [])

    def test_no_section_is_v1_and_routes_not_needed(self):
        text = "**Goal:** Do a thing.\n"
        got = vs.parse(text)
        self.assertIs(got["present"], False)
        self.assertEqual([p["item"] for p in got["problems"]], ["V1"])
        self.assertEqual(vs.route(got), "not_needed")
        self.assertIs(vs.needs_watch(text), False)
        self.assertEqual([p["item"] for p in vs.parse(None)["problems"]], ["V1"])

    def test_daily_is_v3_and_names_the_line_and_the_form(self):
        got = vs.parse(desc(YES.replace("Check every: 1 day", "Check every: daily")))
        self.assertEqual([p["item"] for p in got["problems"]], ["V3"])
        self.assertIn("Check every: 'daily'", got["problems"][0]["found"])
        self.assertIn("<n> hours", got["problems"][0]["needed"])
        self.assertEqual(vs.route(got), "unreadable")
        self.assertIs(vs.needs_watch(desc(YES.replace("Check every: 1 day", "Check every: daily"))), True)

    def test_unknown_collector_is_v5(self):
        self.assertEqual(items(YES.replace("job retire-session-atlas", "weather today")), ["V5"])

    def test_each_item_fails_alone(self):
        no_scenarios = YES[:YES.index("```gherkin")]
        manual_only = no_scenarios + ("```gherkin\n@validate @manual\nScenario: The summaries read well\n"
                                      "  Then Josh confirms that the summaries read as plain English\n```\n")
        table = [
            ("no Needed line", YES.replace("- Needed: yes\n", ""), "V1", ""),
            ("Needed: maybe", YES.replace("Needed: yes", "Needed: maybe"), "V1", ""),
            ("Needed twice", YES.replace("- Needed: yes\n", "- Needed: yes\n- Needed: yes\n"), "V1", ""),
            ("short reason", NO.replace("no. The change is a document; nothing runs in production.", "no. Docs only."),
             "V2", ""),
            ("no with a Starts line", NO + "- Starts: at Deployed\n", "V2", ""),
            ("no with a scenario", NO + "\n```gherkin\n@validate\nScenario: x\n  When the watch reads job a\n"
             "  Then last_exit is 0\n```\n", "V2", ""),
            ("impossible date", YES.replace("at Deployed", "on 2026-02-30"), "V3", ""),
            ("waits for itself", YES.replace("at Deployed", "after JP-9001 is Done"), "V3", "JP-9001"),
            ("check every 8 days", YES.replace("Check every: 1 day", "Check every: 8 days"), "V3", ""),
            ("give up 91 days", YES.replace("21 days", "91 days"), "V3", ""),
            ("no Complete when", YES.replace("- Complete when: 7 checks in a row pass\n", ""), "V3", ""),
            ("no scenario", no_scenarios, "V4", ""),
            ("manual only", manual_only, "V4", ""),
            ("untagged scenario", YES.replace("@validate\nScenario: The retirement", "Scenario: The retirement"), "V4", ""),
            ("job id with spaces", YES.replace("job retire-session-atlas", "job Retire Job"), "V5", ""),
            ("a Given line", YES.replace("  When the watch reads job", "  Given the laptop is on\n  When the watch reads job"),
             "V5", ""),
            ("two When lines", YES.replace("  Then last_exit is 0", "  When the watch reads job other\n  Then last_exit is 0"),
             "V5", ""),
            ("field not returned", YES.replace("Then last_exit is 0", "Then exit_code is 0"), "V6", ""),
            ("comparison not on the list", YES.replace("Then last_exit is 0", "Then last_exit equals 0"), "V6", ""),
            ("ordering with a word", YES.replace("Then last_exit is 0", "Then last_exit is at least pass"), "V6", ""),
            ("ordering on a code field", EVENTS.replace("ledger-runs non-development", "doctor backfills.atlas")
             .replace("Then needs_josh is at most 1", "Then status is at least pass")
             .replace("after 20 events", "5 checks in a row pass"), "V6", ""),
            ("a word for a number", YES.replace("Then last_exit is 0", "Then last_exit is pass"), "V6", ""),
            ("not enough days", YES.replace("21 days", "5 days"), "V7", ""),
            ("events with a job", YES.replace("7 checks in a row pass", "after 20 events"), "V7", ""),
        ]
        for label, text, item, key in table:
            with self.subTest(label):
                self.assertEqual(items(text, key), [item])

    def test_manual_criterion_reads_its_statement(self):
        text = YES + ("\n```gherkin\n@validate @manual\nScenario: The summaries read well\n"
                      "  Then Josh confirms that the summaries read as plain English\n```\n")
        got = vs.parse(desc(text))
        self.assertEqual(got["problems"], [])
        manual = got["criteria"][-1]
        self.assertIs(manual["manual"], True)
        self.assertEqual(manual["statement"], "the summaries read as plain English")
        self.assertEqual(manual["checks"], [])
        self.assertEqual((manual["collector"], manual["argument"]), ("", ""))

    def test_fail_after_line_is_read(self):
        got = vs.parse(desc(YES.replace("- Give up after: 21 days\n",
                                        "- Give up after: 21 days\n- Fail after: 5 checks in a row fail\n")))
        self.assertEqual(got["fail_after"], 5)
        self.assertEqual(got["problems"], [])

    def test_argument_is_kept_as_text(self):
        argument = 'project = JP AND labels = "x; rm -rf" AND created >= -7d'
        text = EVENTS.replace("ledger-runs non-development", "jira-count " + argument) \
                     .replace("Then needs_josh is at most 1", "Then count is at most 1")
        got = vs.parse(desc(text))
        self.assertEqual(got["problems"], [])
        self.assertEqual(got["criteria"][0]["argument"], argument)

    def test_version_follows_the_section_only(self):
        base = vs.parse(desc(YES))["section_version"]
        self.assertEqual(vs.parse(desc(YES, goal="A different goal."))["section_version"], base)
        self.assertNotEqual(vs.parse(desc(YES.replace("7 checks", "8 checks")))["section_version"], base)
        self.assertEqual(len(base), 16)

    def test_validation_block_is_not_an_acceptance_scenario(self):
        text = desc(YES)
        self.assertNotIn("@validate", parse_sections(text)["Acceptance criteria"])
        names = dev_spec.scenario_names(text)
        self.assertEqual(names, ["The job exits clean"])
        for name in ("The retirement job runs clean", "The doctor reports no failed check"):
            self.assertNotIn(name, names)

    def test_argument_must_match_whole(self):
        self.assertTrue(vs.argument_ok("job", "sample-job"))
        for collector, argument in (("job", "sample-job\n"), ("jira-count", "project = JP\n"), ("nothing", "x")):
            self.assertFalse(vs.argument_ok(collector, argument))
        sample = {"job": "sample-job", "report": "doctor summary.fail", "doctor": "backfills.retire-session-atlas",
                  "ledger-runs": "non-development", "jira-count": "project = JP",
                  "github-runs": "joshgilpatrick/josh-360 test.yml"}
        self.assertEqual(set(sample), set(DECLARED))
        for name, argument in sample.items():
            self.assertTrue(vs.argument_ok(name, argument), name)
            self.assertFalse(vs.argument_ok(name, argument + "\n"), name)

    def test_declared_is_the_specs_table(self):
        self.assertEqual(set(DECLARED), {"job", "report", "doctor", "ledger-runs", "jira-count", "github-runs"})
        want = {"job": ({"last_exit": "number", "hours_since_run": "number"}, False),
                "report": ({"value": "value", "age_hours": "number"}, False),
                "doctor": ({"status": "code"}, False),
                "ledger-runs": ({"events": "number", "success": "number", "neutral": "number",
                                 "needs_josh": "number"}, True),
                "jira-count": ({"count": "number", "events": "number"}, True),
                "github-runs": ({"events": "number", "failed": "number", "last": "code"}, True)}
        for name, (fields, counts) in want.items():
            self.assertEqual(DECLARED[name]["fields"], fields, name)
            self.assertIs(DECLARED[name]["counts_events"], counts, name)

    def test_split_gives_field_lines_and_the_block(self):
        body = parse_sections(desc(YES))["Validation"]
        lines, block = vs.split(body)
        self.assertEqual(len(lines), 5)
        self.assertEqual(lines[0], "Needed: yes")
        self.assertIn("The retirement job runs clean", block)
        self.assertIn("The doctor reports no failed check", block)
        self.assertEqual(vs.split("- Needed: no. Docs.")[1], "")

    def test_the_two_readers(self):
        self.assertEqual(vs.read_starts("at Deployed"), ("deployed", ""))
        self.assertEqual(vs.read_starts("on 2026-12-01"), ("date", "2026-12-01"))
        self.assertEqual(vs.read_starts("after JP-170 is Done"), ("ticket", "JP-170"))
        self.assertIsNone(vs.read_starts("tomorrow"))
        self.assertEqual(vs.read_complete_when("7 checks in a row pass"), ("streak", 7))
        self.assertEqual(vs.read_complete_when("after 20 events"), ("events", 20))
        self.assertIsNone(vs.read_complete_when("after 0 events"))

    def test_a_trailing_newline_is_not_a_short_code_or_a_form(self):
        self.assertIsNone(vs.read_starts("at Deployed\n"))
        self.assertIsNone(vs.read_complete_when("7 checks in a row pass\n"))

    def test_a_bare_validation_line_opens_the_section(self):
        # the section opens like every other section does: a plain "Validation" line alone also opens it for the
        # description reader, so the strict ticket reader (lib.triage.ticket) is what reports a missing one
        self.assertTrue(vs.parse("Validation\n- Needed: no. The change is a document.\n")["present"])


class TheContract(unittest.TestCase):
    def test_contract_table_lists_every_collector_and_field(self):
        text = (ROOT / "graphs" / "contracts" / "validation-section.md").read_text(encoding="utf-8")
        for name, entry in DECLARED.items():
            self.assertIn("`" + name + "`", text, name)
            for field in entry["fields"]:
                self.assertIn("`" + field + "`", text, name + " " + field)
        for comparison in COMPARISONS:
            self.assertIn("`" + comparison + "`", text, comparison)


if __name__ == "__main__":
    unittest.main()
