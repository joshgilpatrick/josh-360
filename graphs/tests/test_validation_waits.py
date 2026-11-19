"""JP-167, Task 9: start-watch, watch-criteria and fix-closed. Made-up tickets, a made-up clock, no network, no model.

Run: python3 -m unittest discover -s graphs/tests -p "test_validation_waits.py"   (from the repository root)
"""
from __future__ import annotations

import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

import validation_gate_helpers as h
from validation_gate_helpers import KEY, T0, Site, load_gate

from lib import validation_copy as copy
from lib.gate_run import GateError
from lib.watch import log, round as watch_round, timetable

read_validation = load_gate("read-validation")
start_watch = load_gate("start-watch")
watch_criteria = load_gate("watch-criteria")
fix_closed = load_gate("fix-closed")

BUG = "JP-9002"


def stringify(outputs):
    """What the walker hands the next gate: text stays text, everything else is one JSON value."""
    return {k: v if isinstance(v, str) else json.dumps(v) for k, v in outputs.items()}


def local(when):
    return when.astimezone().strftime("%Y-%m-%d %H:%M")


class Base(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.site = Site(tmp.name)
        self.deps = self.site.deps
        self.folder = self.deps.work_dir / "watch"

    def inputs(self, key=KEY):
        _, out, _ = read_validation.run({"ticket_key": key}, self.deps)
        return dict(stringify(out), ticket_key=key)

    def start(self, key=KEY):
        return start_watch.run(self.inputs(key), self.deps)

    def plan(self, n=1):
        return json.loads((self.folder / "round-{}.json".format(n)).read_text())


class StartingTheWatch(Base):
    def test_start_writes_round_one_and_comments_once(self):
        self.site.seed()
        outcome, outputs, _ = self.start()
        self.assertEqual(outcome, "started")
        self.assertEqual(Path(outputs["watch_file"]), self.folder / "round-1.json")
        plan = self.plan()
        self.assertEqual((plan["round"], plan["ticket_key"]), (1, KEY))
        self.assertEqual(plan["begins_at"], plan["started_at"])
        self.assertEqual(plan["started_at"], timetable.iso(T0))
        self.assertEqual(plan["first_check_at"], timetable.iso(T0 + timedelta(hours=1)))
        self.assertEqual((plan["complete_kind"], plan["complete_n"], plan["fail_after"], plan["starts_kind"]),
                         ("streak", 3, 3, "deployed"))
        self.assertEqual(len(plan["criteria"]), 1)
        self.assertEqual(len(plan["section_version"]), 16)
        expected = copy.start(1, 1, "3 checks in a row pass", 2, local(T0 + timedelta(hours=1)))
        self.assertEqual(self.site.comment_texts(KEY), [expected])
        self.start()
        self.assertEqual(len(list(self.folder.glob("round-*.json"))), 1)
        self.assertEqual(self.site.comment_texts(KEY), [expected])

    def test_start_after_an_ended_round_writes_round_two(self):
        self.site.seed()
        self.start()
        first = self.folder / "round-1.json"
        log.append(log.path_for(first), {"kind": "end", "at": "2026-11-18T13:00:00Z", "result": "not_met",
                                         "reason": "fail_after", "tally": []})
        self.site.advance(hours=3)
        _, outputs, _ = self.start()
        self.assertEqual(Path(outputs["watch_file"]), self.folder / "round-2.json")
        self.assertEqual(self.plan(2)["round"], 2)

    def test_a_round_that_has_taken_a_check_is_not_reused(self):
        self.site.seed()
        self.start()
        log.append(log.path_for(self.folder / "round-1.json"),
                   {"kind": "check", "at": "2026-11-18T13:00:00Z", "n": 1, "result": "pass", "criteria": {}})
        self.start()
        self.assertTrue((self.folder / "round-2.json").is_file())

    def test_an_edited_section_starts_a_new_round(self):
        self.site.seed()
        self.start()
        self.site.set_validation(KEY, h.YES.replace("3 checks", "2 checks"))
        self.start()
        self.assertEqual(self.plan(2)["complete_n"], 2)

    def test_start_on_a_date_and_after_a_ticket(self):
        self.site.seed(validation=h.YES.replace("at Deployed", "on 2026-11-25"))
        self.start()
        plan = self.plan()
        midnight = datetime(2026, 11, 25).astimezone(timezone.utc)
        self.assertEqual((plan["starts_kind"], plan["starts_date"], plan["begins_at"]),
                         ("date", "2026-11-25", timetable.iso(midnight)))
        self.assertEqual(plan["first_check_at"], timetable.iso(midnight + timedelta(hours=1)))

        self.site.seed("JP-9003", validation=h.YES.replace("at Deployed", "after JP-170 is Done"))
        self.start("JP-9003")
        plan = self.plan(2)
        self.assertEqual((plan["starts_kind"], plan["starts_ticket"], plan["begins_at"], plan["first_check_at"]),
                         ("ticket", "JP-170", "", ""))
        self.assertTrue(self.site.comment_texts("JP-9003")[-1].endswith(
            "first check due one check after JP-170 is Done."))

    def test_start_writes_nothing_to_a_ticket_that_left_deployed(self):
        self.site.seed(status="In Progress")
        outcome, _, _ = self.start()
        self.assertEqual(outcome, "started")
        self.assertEqual(self.site.comment_texts(KEY), [])
        self.assertEqual(self.site.writes(), [])

    def test_start_stops_when_the_status_cannot_be_read(self):
        self.site.seed()
        inputs = self.inputs()
        inputs["ticket_key"] = "JP-9404"
        with self.assertRaises(GateError):
            start_watch.run(inputs, self.deps)

    def test_a_form_the_readers_refuse_stops_the_start(self):
        self.site.seed()
        inputs = self.inputs()
        inputs["starts"] = "whenever"
        with self.assertRaises(GateError):
            start_watch.run(inputs, self.deps)


class TheWatchWait(Base):
    def test_watch_gate_passes_the_step_through(self):
        self.site.seed()
        _, outputs, _ = self.start()
        outcome, out, _ = watch_criteria.run({"ticket_key": KEY, "watch_file": outputs["watch_file"]}, self.deps)
        self.assertEqual((outcome, out), ("pending", None))

    def test_an_unreadable_watch_file_stops_the_run(self):
        with self.assertRaises(GateError):
            watch_criteria.run({"ticket_key": KEY, "watch_file": str(self.folder / "round-9.json")}, self.deps)


class WaitingForTheFix(Base):
    def setUp(self):
        super().setUp()
        self.site.seed(KEY, "Deployed")
        self.site.seed(BUG, "Not Started", issuetype="Bug", labels=("validation-failure",))
        self.failed_round(1)

    def failed_round(self, n):
        path = self.folder / "round-{}.json".format(n)
        plan = dict(ticket_key=KEY, round=n, criteria=[{"id": "V1", "name": "The job runs clean", "manual": False}])
        watch_round.write_plan(path, plan)
        log.append(log.path_for(path), {"kind": "end", "at": "2026-11-18T13:00:00Z", "result": "not_met",
                                        "reason": "fail_after", "tally": [
                                            {"id": "V1", "checks": 3, "passed": 0, "failed": 3, "unknown": 0,
                                             "streak": 0, "last": {}, "link": ""}]})

    def wait(self):
        return fix_closed.run({"ticket_key": KEY, "bug_key": BUG}, self.deps)

    def test_fix_closed_waits_while_the_bug_is_open(self):
        self.assertEqual(self.wait()[0], "pending")
        self.assertTrue((self.folder / "fix-{}.json".format(BUG)).is_file())

    def test_fix_closed_looks_once_an_hour(self):
        self.wait()
        before = len(self.site.calls())
        self.site.advance(minutes=10)
        self.site.set_status(BUG, "Done")
        self.assertEqual(self.wait()[0], "pending")
        self.assertEqual(len(self.site.calls()), before)
        self.site.advance(minutes=51)
        self.assertEqual(self.wait()[0], "shipped")

    def test_fix_closed_shipped_writes_the_card(self):
        self.failed_round(2)
        self.site.set_status(BUG, "Done")
        outcome, outputs, _ = self.wait()
        self.assertEqual(outcome, "shipped")
        first = Path(outputs["card"]).read_text().split("\n")[0]
        self.assertIn(BUG, first)
        self.assertIn("2 rounds", first)
        self.assertEqual(Path(outputs["card"]), self.folder / "card.md")

    def test_fix_closed_cancelled(self):
        self.site.set_status(BUG, "Cancelled")
        outcome, outputs, _ = self.wait()
        self.assertEqual(outcome, "cancelled")
        text = Path(outputs["card"]).read_text()
        self.assertIn(BUG, text.split("\n")[0])
        self.assertIn("The job runs clean", text)

    def test_a_bug_that_is_gone_counts_as_cancelled(self):
        outcome, _, _ = fix_closed.run({"ticket_key": KEY, "bug_key": "JP-9404"}, self.deps)
        self.assertEqual(outcome, "cancelled")

    def test_fix_closed_left_deployed(self):
        self.site.set_status(KEY, "In Progress")
        self.assertEqual(self.wait()[0], "left_deployed")

    def test_fix_closed_unknown_keeps_waiting(self):
        outcome, _, _ = fix_closed.run({"ticket_key": "JP-9404", "bug_key": BUG}, self.deps)
        self.assertEqual(outcome, "pending")

    def test_a_wait_writes_only_its_own_notes(self):
        self.site.set_status(BUG, "Done")
        before = self.site.writes()
        self.wait()
        self.assertEqual(self.site.writes(), before)


if __name__ == "__main__":
    unittest.main()
