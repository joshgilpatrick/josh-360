"""JP-166: when a watch begins and ends, and how a check log is graded. Pure functions on made-up lines.

Run: python3 -m unittest discover -s graphs/tests   (from the repository root)
"""
from __future__ import annotations

import os
import sys
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

GATES = Path(__file__).resolve().parent.parent / "gates"
sys.path.insert(0, str(GATES))

from lib.watch import grading, timetable  # noqa: E402

UTC = timezone.utc
RESULTS = {"p": "pass", "f": "fail", "u": "unknown", "w": "waiting"}


def criterion(cid="V1", manual=False):
    if manual:
        return {"id": cid, "name": "It reads well", "collector": "", "argument": "", "checks": [], "manual": True,
                "statement": "the summaries read as plain English"}
    return {"id": cid, "name": "The job runs clean", "collector": "job", "argument": "sample-job",
            "checks": [{"field": "last_exit", "comparison": "is", "value": 0}], "manual": False, "statement": ""}


def streak(n, fail_after=3, manual=False):
    criteria = [criterion("V1")] + ([criterion("V2", manual=True)] if manual else [])
    return {"complete_kind": "streak", "complete_n": n, "fail_after": fail_after, "criteria": criteria}


def events(n, manual=False):
    plan = streak(n, manual=manual)
    plan["complete_kind"] = "events"
    return plan


def checks(letters: str):
    """Check lines for one criterion, V1: p pass, f fail, u unknown, w waiting (events mode)."""
    start = datetime(2026, 11, 18, 0, 0, tzinfo=UTC)
    return [{"kind": "check", "at": timetable.iso(start + timedelta(days=i)), "n": i + 1, "result": RESULTS[letter],
             "criteria": {"V1": {"result": RESULTS[letter], "fields": {"last_exit": 0 if letter == "p" else 1},
                                 "link": "reports/x"}}}
            for i, letter in enumerate(letters)]


class GradingTest(unittest.TestCase):
    def test_seven_passes_in_a_row_are_met(self):
        self.assertEqual(grading.grade(checks("ppppppp"), streak(7), False), ("met", "streak"))
        self.assertIsNone(grading.grade(checks("pppppp"), streak(7), False))

    def test_an_unknown_neither_counts_nor_breaks(self):
        self.assertEqual(grading.tally(streak(4), checks("pppup"))[0]["streak"], 4)
        self.assertEqual(grading.grade(checks("pppup"), streak(4), False), ("met", "streak"))

    def test_three_fails_end_it_early(self):
        self.assertEqual(grading.grade(checks("pfff"), streak(7, fail_after=3), False), ("not_met", "fail_after"))

    def test_fail_after_five_waits(self):
        self.assertIsNone(grading.grade(checks("fff"), streak(7, fail_after=5), False))
        self.assertEqual(grading.grade(checks("fffff"), streak(7, fail_after=5), False), ("not_met", "fail_after"))

    def test_fail_after_defaults_to_three(self):
        plan = streak(7)
        del plan["fail_after"]
        self.assertEqual(grading.grade(checks("fff"), plan, False), ("not_met", "fail_after"))

    def test_an_unknown_between_fails_does_not_break_the_run_of_fails(self):
        self.assertEqual(grading.grade(checks("ffuf"), streak(7), False), ("not_met", "fail_after"))

    def test_a_fail_breaks_the_run_of_passes(self):
        self.assertIsNone(grading.grade(checks("ppfpp"), streak(3), False))

    def test_gave_up_with_a_fail_is_not_met(self):
        self.assertEqual(grading.grade(checks("pfp"), streak(7), True), ("not_met", "gave_up"))

    def test_gave_up_with_no_fail_is_no_data(self):
        for letters in ("ppu", "", "uuu"):
            self.assertEqual(grading.grade(checks(letters), streak(7), True), ("no_data", "gave_up"), letters)

    def test_not_yet_when_nothing_decides_it(self):
        self.assertIsNone(grading.grade([], streak(7), False))
        self.assertIsNone(grading.grade(checks("pfp"), streak(7), False))

    def test_lines_that_are_not_checks_are_ignored(self):
        lines = [{"kind": "look", "at": "2026-11-18T00:00:00Z", "status": "Deployed"}] + checks("ppp") + \
                [{"kind": "began", "at": "2026-11-18T00:00:00Z"}]
        self.assertEqual(grading.grade(lines, streak(3), False), ("met", "streak"))

    def test_manual_criterion_turns_met_into_needs_josh(self):
        self.assertEqual(grading.grade(checks("ppp"), streak(3, manual=True), False), ("needs_josh", "streak"))
        self.assertEqual(grading.grade(checks("p"), events(1, manual=True), False),
                         ("needs_josh", "events"))
        self.assertEqual(grading.grade(checks("fff"), streak(3, manual=True), False), ("not_met", "fail_after"))

    def test_events_wait_then_compare_once(self):
        self.assertEqual(grading.grade(checks("wwp"), events(20), False), ("met", "events"))
        self.assertEqual(grading.grade(checks("wf"), events(20), False), ("not_met", "events"))
        self.assertEqual(grading.grade(checks("w"), events(20), True), ("no_data", "gave_up"))
        self.assertIsNone(grading.grade(checks("wu"), events(20), False))
        self.assertIsNone(grading.grade(checks("w"), events(20), False))
        self.assertEqual(grading.grade(checks("wu"), events(20), True), ("no_data", "gave_up"))

    def test_events_ready_needs_every_criterion(self):
        plan = streak(20)
        plan["criteria"].append(criterion("V2"))

        def reading(n):
            return {"fields": {"events": n}, "link": ""}
        self.assertFalse(grading.events_ready(plan, {"V1": reading(20), "V2": reading(19)}))
        self.assertTrue(grading.events_ready(plan, {"V1": reading(20), "V2": reading(25)}))
        self.assertFalse(grading.events_ready(plan, {"V1": reading(20), "V2": reading(None)}))
        self.assertFalse(grading.events_ready(plan, {"V1": reading(20)}))

    def test_events_ready_ignores_a_manual_criterion(self):
        plan = streak(5, manual=True)
        self.assertTrue(grading.events_ready(plan, {"V1": {"fields": {"events": 5}, "link": ""}}))

    def test_holds(self):
        self.assertIs(grading.holds(0, "is", 0), True)
        self.assertIs(grading.holds(0.0, "is", 0), True)
        self.assertIs(grading.holds("pass", "is", "pass"), True)
        self.assertIs(grading.holds("pass", "is not", "fail"), True)
        self.assertIs(grading.holds(2, "is at most", 2), True)
        self.assertIs(grading.holds(2, "is at least", 2), True)
        self.assertIs(grading.holds(2, "is below", 2), False)
        self.assertIs(grading.holds(3, "is above", 2), True)
        self.assertIs(grading.holds(1, "is not", 1), False)
        self.assertIsNone(grading.holds(None, "is", 0))
        self.assertIsNone(grading.holds("pass", "is at least", 1))
        self.assertIsNone(grading.holds(1, "is above", "one"))
        self.assertIsNone(grading.holds(1, "equals", 1))

    def test_judge_and_check_result(self):
        two = {"id": "V1", "checks": [{"field": "a", "comparison": "is", "value": 0},
                                      {"field": "b", "comparison": "is at most", "value": 2}]}
        self.assertEqual(grading.judge(two, {"fields": {"a": 0, "b": 1}}), "pass")
        self.assertEqual(grading.judge(two, {"fields": {"a": 0, "b": None}}), "unknown")
        self.assertEqual(grading.judge(two, {"fields": {"a": 1, "b": None}}), "fail")
        self.assertEqual(grading.judge(two, {"fields": {}}), "unknown")
        self.assertEqual(grading.check_result(["pass", "unknown"]), "unknown")
        self.assertEqual(grading.check_result(["unknown", "fail"]), "fail")
        self.assertEqual(grading.check_result(["pass", "pass"]), "pass")
        self.assertEqual(grading.check_result([]), "unknown")

    def test_tally_counts_each_criterion(self):
        tally = grading.tally(streak(7, manual=True), checks("ppfupp"))
        self.assertEqual(len(tally), 2)
        first = tally[0]
        self.assertEqual((first["id"], first["checks"], first["passed"], first["failed"], first["unknown"],
                          first["streak"]), ("V1", 6, 4, 1, 1, 2))
        self.assertEqual(first["last"], {"last_exit": 0})
        self.assertEqual(first["link"], "reports/x")
        self.assertEqual(tally[1], {"id": "V2", "checks": 0, "passed": 0, "failed": 0, "unknown": 0, "streak": 0,
                                    "last": {}, "link": ""})

    def test_tally_with_no_checks_is_zeros(self):
        self.assertEqual(grading.tally(streak(7), [])[0]["checks"], 0)

    def test_met_on_is_the_number_of_the_last_check(self):
        self.assertEqual(grading.met_on(checks("ppp")), 3)
        self.assertEqual(grading.met_on([]), 0)


class TimetableTest(unittest.TestCase):
    def test_date_start_is_local_midnight(self):
        old = os.environ.get("TZ")
        os.environ["TZ"] = "America/Los_Angeles"
        time.tzset()
        try:
            started = datetime(2026, 11, 28, 10, 0, tzinfo=UTC)
            self.assertEqual(timetable.iso(timetable.begins_at("date", "2026-12-01", started)), "2026-12-01T08:00:00Z")
            late = datetime(2026, 12, 5, 10, 0, tzinfo=UTC)
            self.assertEqual(timetable.begins_at("date", "2026-12-01", late), late)
        finally:
            if old is None:
                os.environ.pop("TZ", None)
            else:
                os.environ["TZ"] = old
            time.tzset()

    def test_deployed_and_ticket_starts(self):
        started = datetime(2026, 11, 18, 10, 0, tzinfo=UTC)
        self.assertEqual(timetable.begins_at("deployed", "", started), started)
        self.assertIsNone(timetable.begins_at("ticket", "", started))

    def test_an_unreadable_date_is_an_error_not_a_guess(self):
        with self.assertRaises(ValueError):
            timetable.begins_at("date", "2026-02-30", datetime(2026, 11, 18, tzinfo=UTC))
        with self.assertRaises(ValueError):
            timetable.begins_at("sometime", "", datetime(2026, 11, 18, tzinfo=UTC))

    def test_first_check_and_give_up_count_from_the_beginning(self):
        b = datetime(2026, 11, 18, 10, 0, tzinfo=UTC)
        self.assertEqual(timetable.first_check_at(b, 24), b + timedelta(hours=24))
        self.assertTrue(timetable.gave_up(b, 21, b + timedelta(days=21)))
        self.assertFalse(timetable.gave_up(b, 21, b + timedelta(days=21) - timedelta(seconds=1)))
        self.assertTrue(timetable.never_began(b, b + timedelta(days=90)))
        self.assertFalse(timetable.never_began(b, b + timedelta(days=90) - timedelta(seconds=1)))

    def test_iso_and_parse_round_trip(self):
        when = datetime(2026, 11, 18, 23, 5, 0, tzinfo=UTC)
        self.assertEqual(timetable.iso(when), "2026-11-18T23:05:00Z")
        self.assertEqual(timetable.parse("2026-11-18T23:05:00Z"), when)
        self.assertEqual(timetable.parse("2026-11-18T23:05:00+00:00"), when)
        self.assertIsNone(timetable.parse("yesterday"))
        self.assertIsNone(timetable.parse(""))
        self.assertIsNone(timetable.parse(None))

    def test_iso_of_another_zone_is_converted_to_utc(self):
        when = datetime(2026, 11, 18, 15, 5, 0, tzinfo=timezone(timedelta(hours=-8)))
        self.assertEqual(timetable.iso(when), "2026-11-18T23:05:00Z")

    def test_constants(self):
        self.assertEqual(timetable.NEVER_BEGAN_DAYS, 90)
        self.assertEqual(timetable.LOOK_SECONDS, 3600)


if __name__ == "__main__":
    unittest.main()
