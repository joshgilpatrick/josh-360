"""JP-166: the check log and one call of the watch (`lib.watch.round.step`), on made-up watch files, a made-up clock and
a made-up Jira that can only be read. No network, no model, no real collector.

Run: python3 -m unittest discover -s graphs/tests   (from the repository root)
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

GATES = Path(__file__).resolve().parent.parent / "gates"
sys.path.insert(0, str(GATES))

from watch_helpers import FakeJiraReader  # noqa: E402

from lib.gate_run import GateError  # noqa: E402
from lib.watch import log, round as watch_round, tickets, timetable  # noqa: E402

UTC = timezone.utc
T0 = datetime(2026, 11, 18, 12, 0, 0, tzinfo=UTC)
KEY = "JP-9001"
HOUR = timedelta(hours=1)
DAY = timedelta(days=1)
PASS = {"fields": {"last_exit": 0}, "link": "reports/x"}
FAIL = {"fields": {"last_exit": 1}, "link": "reports/x"}
NOTHING = {"fields": {"last_exit": None}, "link": ""}


def criterion(cid="V1", checks=None, collector="job", argument="sample-job", manual=False):
    if manual:
        return {"id": cid, "name": "It reads well", "collector": "", "argument": "", "checks": [], "manual": True,
                "statement": "the summaries read as plain English"}
    return {"id": cid, "name": "The job runs clean", "collector": collector, "argument": argument,
            "checks": checks or [{"field": "last_exit", "comparison": "is", "value": 0}], "manual": False,
            "statement": ""}


class WatchCase(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.folder = Path(tmp.name) / "work" / "watch"
        self.clock = T0
        self.jira = FakeJiraReader({KEY: "Deployed"})
        self.deps = SimpleNamespace(now=lambda: self.clock, jira=self.jira)
        self.reading = PASS
        self.reads = []
        self.readers = {"job": self.read_job}

    def read_job(self, argument, since, deps):
        self.reads.append((argument, since))
        if isinstance(self.reading, Exception):
            raise self.reading
        return self.reading

    def plan(self, **changes) -> Path:
        plan = {"ticket_key": KEY, "round": 1, "started_at": timetable.iso(T0), "begins_at": timetable.iso(T0),
                "first_check_at": timetable.iso(T0 + DAY), "starts": "at Deployed", "starts_kind": "deployed",
                "starts_date": "", "starts_ticket": "", "check_every_hours": 24,
                "complete_when": "7 checks in a row pass", "complete_kind": "streak", "complete_n": 7,
                "give_up_days": 21, "fail_after": 3, "criteria": [criterion()], "section_version": "9f2c41d07ab3e655"}
        plan.update(changes)
        self.path = self.folder / "round-1.json"
        watch_round.write_plan(self.path, plan)
        return self.path

    def call(self):
        return watch_round.step(self.path, self.deps, self.readers)

    def advance(self, delta):
        self.clock = self.clock + delta
        return self.call()

    def lines(self, kind=None):
        found = log.read(log.path_for(self.path))
        return [line for line in found if kind is None or line["kind"] == kind]

    def log_bytes(self):
        path = log.path_for(self.path)
        return path.read_bytes() if path.exists() else b""


class LogTest(WatchCase):
    def test_path_for_sits_beside_the_watch_file(self):
        self.assertEqual(log.path_for(Path("/x/work/watch/round-3.json")), Path("/x/work/watch/round-3.checks.jsonl"))

    def test_read_skips_a_line_that_is_not_an_object(self):
        self.plan()
        path = log.path_for(self.path)
        path.write_text('{"kind": "look"}\nnot json\n[1, 2]\n"text"\n{"kind": "che')
        self.assertEqual(log.read(path), [{"kind": "look"}])

    def test_read_of_no_file_is_empty(self):
        self.assertEqual(log.read(self.folder / "round-9.checks.jsonl"), [])

    def test_append_writes_one_line_and_starts_a_torn_one_afresh(self):
        self.plan()
        path = log.path_for(self.path)
        log.append(path, {"kind": "look", "at": "x"})
        log.append(path, {"kind": "check", "n": 1})
        self.assertEqual(path.read_text().count("\n"), 2)
        path.write_text(path.read_text() + '{"kind": "che')
        log.append(path, {"kind": "end"})
        self.assertEqual([line["kind"] for line in log.read(path)], ["look", "check", "end"])
        self.assertIn('{"kind": "che\n{"kind": "end"}\n', path.read_text())

    def test_last_finds_the_newest_of_a_kind(self):
        lines = [{"kind": "look", "n": 1}, {"kind": "check"}, {"kind": "look", "n": 2}]
        self.assertEqual(log.last(lines, "look"), {"kind": "look", "n": 2})
        self.assertIsNone(log.last(lines, "end"))


class TicketsTest(unittest.TestCase):
    def test_status_and_state(self):
        jira = FakeJiraReader({"JP-1": "Deployed", "JP-2": "Done", "JP-3": "Cancelled", "JP-4": "Code Review"})
        self.assertEqual(tickets.status(jira, "JP-1"), "Deployed")
        self.assertEqual([tickets.state(jira, k) for k in ("JP-1", "JP-2", "JP-3", "JP-4")],
                         ["open", "done", "cancelled", "open"])
        self.assertEqual(tickets.state(jira, "JP-404"), "missing")
        self.assertIsNone(tickets.status(jira, "JP-404"))

    def test_a_failed_read_is_unknown_never_missing_or_open(self):
        jira = FakeJiraReader({"JP-1": "Done"})
        jira.read_fails = True
        self.assertIsNone(tickets.status(jira, "JP-1"))
        self.assertEqual(tickets.state(jira, "JP-1"), "unknown")

    def test_a_jira_that_raises_is_unknown(self):
        class Broken:
            def get(self, *args, **kwargs):
                raise RuntimeError("down")
            exists = get
        self.assertIsNone(tickets.status(Broken(), "JP-1"))
        self.assertEqual(tickets.state(Broken(), "JP-1"), "unknown")

    def test_a_done_category_ticket_with_another_name_is_done(self):
        class Jira:
            def get(self, key, fields=None):
                return {"key": key, "status": "Shipped", "status_category": "done"}
            def exists(self, key):
                return True
        self.assertEqual(tickets.state(Jira(), "JP-1"), "done")


class RoundFilesTest(WatchCase):
    def test_next_round_counts_the_watch_files(self):
        self.assertEqual(watch_round.next_round(self.folder), (1, self.folder / "round-1.json"))
        self.plan()
        (self.folder / "round-1.checks.jsonl").write_text("")
        n, path = watch_round.next_round(self.folder)
        self.assertEqual((n, path), (2, self.folder / "round-2.json"))
        self.assertEqual(watch_round.newest(self.folder), self.folder / "round-1.json")

    def test_newest_is_the_highest_number_not_the_last_name(self):
        for n in (2, 10, 9):
            (self.folder).mkdir(parents=True, exist_ok=True)
            (self.folder / "round-{}.json".format(n)).write_text("{}")
        self.assertEqual(watch_round.newest(self.folder), self.folder / "round-10.json")
        self.assertIsNone(watch_round.newest(self.folder / "nowhere"))

    def test_a_file_name_with_a_trailing_newline_is_not_a_watch_file(self):
        self.folder.mkdir(parents=True, exist_ok=True)
        (self.folder / "round-9.json\n").write_text("{}")
        self.assertEqual(watch_round.next_round(self.folder)[0], 1)
        self.assertIsNone(watch_round.newest(self.folder))

    def test_write_plan_leaves_no_temporary_file(self):
        self.plan()
        self.assertEqual(sorted(p.name for p in self.folder.iterdir()), ["round-1.json"])
        self.assertEqual(json.loads(self.path.read_text())["ticket_key"], KEY)

    def test_ended_reads_the_end_line(self):
        self.plan()
        self.assertIsNone(watch_round.ended(self.path))
        log.append(log.path_for(self.path), {"kind": "end", "at": "x", "result": "met", "reason": "streak", "tally": []})
        self.assertEqual(watch_round.ended(self.path)["result"], "met")


class StepTest(WatchCase):
    def test_not_due_answers_pending_and_touches_nothing(self):
        self.plan()
        self.clock = T0 + 6 * HOUR
        log.append(log.path_for(self.path), {"kind": "look", "at": timetable.iso(self.clock - timedelta(minutes=10)),
                                             "status": "Deployed", "starts_ticket": ""})
        before = self.log_bytes()
        self.assertEqual(self.call(), ("pending", None, ""))
        self.assertEqual(self.jira.calls, [])
        self.assertEqual(self.reads, [])
        self.assertEqual(self.log_bytes(), before)

    def test_due_check_reads_logs_and_stays_pending(self):
        self.plan()
        outcome, outputs, summary = self.advance(DAY)
        self.assertEqual((outcome, outputs, summary), ("pending", None, ""))
        checks = self.lines("check")
        self.assertEqual(len(checks), 1)
        self.assertEqual((checks[0]["n"], checks[0]["result"]), (1, "pass"))
        self.assertEqual(checks[0]["criteria"]["V1"], {"result": "pass", "fields": {"last_exit": 0}, "link": "reports/x"})
        self.assertEqual(self.lines("look")[0]["status"], "Deployed")
        self.assertEqual(self.reads, [("sample-job", timetable.iso(T0))])

    def test_seven_passes_end_met(self):
        self.plan()
        for _ in range(6):
            self.assertEqual(self.advance(DAY)[0], "pending")
        outcome, outputs, summary = self.advance(DAY)
        self.assertEqual(outcome, "met")
        self.assertEqual(outputs["watch_result"], "met")
        self.assertEqual(outputs["tally"][0]["passed"], 7)
        self.assertIn("met on check 7", summary)
        end = self.lines()[-1]
        self.assertEqual((end["kind"], end["result"], end["reason"]), ("end", "met", "streak"))
        self.assertEqual(end["tally"], outputs["tally"])

    def test_date_start_takes_no_reading_before_it(self):
        begins = T0 + 3 * DAY
        self.plan(starts="on 2026-11-21", starts_kind="date", starts_date="2026-11-21", begins_at=timetable.iso(begins))
        self.assertEqual(self.call()[0], "pending")
        self.assertEqual(self.reads, [])
        self.clock = begins + DAY - timedelta(minutes=1)
        self.assertEqual(self.call()[0], "pending")
        self.assertEqual(self.reads, [])
        self.clock = begins + DAY
        self.call()
        self.assertEqual(len(self.reads), 1)
        self.assertEqual(self.reads[0][1], timetable.iso(begins))

    def test_ticket_start_begins_when_that_ticket_is_done(self):
        self.jira.issues["JP-170"] = "Code Review"
        self.plan(starts="after JP-170 is Done", starts_kind="ticket", starts_ticket="JP-170", begins_at="",
                  first_check_at="", give_up_days=21)
        self.clock = T0 + 30 * DAY
        for _ in range(5):
            self.assertEqual(self.call()[0], "pending")
            self.clock += HOUR
        self.assertEqual(self.reads, [])
        self.assertEqual(self.lines("began"), [])
        self.assertTrue(all(line["starts_ticket"] == "open" for line in self.lines("look")))
        self.jira.issues["JP-170"] = "Done"
        self.assertEqual(self.call()[0], "pending")
        began_at = self.clock
        non_look = [line for line in self.lines() if line["kind"] != "look"]
        self.assertEqual([line["kind"] for line in non_look], ["began"])
        self.assertEqual(timetable.parse(non_look[0]["at"]), began_at)
        self.assertEqual(self.reads, [])
        self.clock = began_at + DAY - timedelta(minutes=1)
        self.call()
        self.assertEqual(self.reads, [])
        self.clock = began_at + DAY
        self.call()
        self.assertEqual(len(self.reads), 1)
        self.assertEqual(self.reads[0][1], timetable.iso(began_at))
        self.assertIsNone(watch_round.ended(self.path))      # 30 days after the round, but 1 day after it began

    def test_cancelled_start_ticket_ends_no_data(self):
        self.jira.issues["JP-170"] = "Cancelled"
        self.plan(starts_kind="ticket", starts_ticket="JP-170", begins_at="", first_check_at="")
        outcome, outputs, _ = self.call()
        self.assertEqual((outcome, outputs["watch_result"]), ("no_data", "no_data"))
        self.assertEqual(self.lines()[-1]["reason"], "starts_cancelled")

    def test_missing_start_ticket_ends_no_data(self):
        self.plan(starts_kind="ticket", starts_ticket="JP-170", begins_at="", first_check_at="")
        self.assertEqual(self.call()[0], "no_data")
        self.assertEqual(self.lines()[-1]["reason"], "starts_missing")

    def test_unreadable_start_ticket_keeps_waiting(self):
        self.jira.issues["JP-170"] = "Done"
        self.jira.read_fails = True
        self.plan(starts_kind="ticket", starts_ticket="JP-170", begins_at="", first_check_at="")
        self.assertEqual(self.call()[0], "pending")
        look = self.lines("look")[0]
        self.assertEqual((look["status"], look["starts_ticket"]), ("unknown", "unknown"))
        self.assertEqual(self.lines("began"), [])
        self.assertIsNone(watch_round.ended(self.path))

    def test_ninety_days_without_beginning_ends_no_data(self):
        self.jira.issues["JP-170"] = "In Progress"
        self.plan(starts_kind="ticket", starts_ticket="JP-170", begins_at="", first_check_at="")
        self.assertEqual(self.advance(90 * DAY - HOUR)[0], "pending")
        self.assertEqual(self.advance(HOUR)[0], "no_data")
        self.assertEqual(self.lines()[-1]["reason"], "never_began")

    def test_all_unknown_until_give_up_ends_no_data(self):
        self.plan()
        self.reading = NOTHING
        for _ in range(20):
            self.assertEqual(self.advance(DAY)[0], "pending")
        outcome, outputs, _ = self.advance(DAY)
        self.assertEqual(outcome, "no_data")
        self.assertEqual(self.lines()[-1]["reason"], "gave_up")
        self.assertEqual(outputs["tally"][0]["unknown"], 21)

    def test_three_fails_end_not_met_early(self):
        self.plan()
        self.reading = FAIL
        self.assertEqual(self.advance(DAY)[0], "pending")
        self.assertEqual(self.advance(DAY)[0], "pending")
        self.assertEqual(self.advance(DAY)[0], "not_met")
        self.assertEqual(self.lines()[-1]["reason"], "fail_after")

    def test_ticket_moved_out_of_deployed_ends_left_deployed(self):
        self.plan()
        self.jira.issues[KEY] = "In Progress"
        outcome, outputs, _ = self.advance(HOUR)
        self.assertEqual((outcome, outputs["watch_result"]), ("left_deployed", "left_deployed"))
        self.assertEqual(self.lines()[-1]["reason"], "left")
        self.assertEqual(self.reads, [])
        self.assertIn("tally", outputs)
        self.assertTrue(all(call[0] in ("get", "exists", "search") for call in self.jira.calls))

    def test_failed_status_read_is_not_left_deployed(self):
        self.plan()
        self.jira.read_fails = True
        self.assertEqual(self.advance(DAY)[0], "pending")
        self.assertEqual(self.lines("look")[0]["status"], "unknown")
        self.assertEqual(self.lines("check"), [])
        self.assertEqual(self.reads, [])
        self.assertIsNone(watch_round.ended(self.path))

    def test_looks_at_most_once_an_hour(self):
        self.plan()
        for _ in range(12):
            self.assertEqual(self.call()[0], "pending")
            self.clock += timedelta(minutes=5)
        self.assertEqual([call for call in self.jira.calls if call[0] == "get"], [("get", KEY)])
        self.assertEqual(len(self.lines("look")), 1)

    def test_overdue_check_is_taken_once(self):
        self.plan(check_every_hours=1)
        self.advance(HOUR)
        self.assertEqual(len(self.lines("check")), 1)
        self.advance(3 * DAY)
        checks = self.lines("check")
        self.assertEqual([c["n"] for c in checks], [1, 2])

    def test_give_up_is_honoured_on_the_first_call_after_a_long_sleep(self):
        self.plan()
        outcome, _, _ = self.advance(40 * DAY)
        self.assertEqual(outcome, "no_data")
        self.assertEqual(len(self.lines("check")), 1)
        self.assertEqual(self.lines()[-1]["reason"], "gave_up")

    def test_end_line_is_returned_again(self):
        self.plan(complete_n=1)
        first = self.advance(DAY)
        self.assertEqual(first[0], "met")
        before = self.log_bytes()
        self.clock += 5 * DAY
        self.jira.calls.clear()
        again = self.call()
        self.assertEqual(again[0], "met")
        self.assertEqual(again[1], first[1])
        self.assertEqual(self.log_bytes(), before)
        self.assertEqual(self.jira.calls, [])

    def test_torn_last_line_is_skipped(self):
        self.plan()
        log.append(log.path_for(self.path), {"kind": "look", "at": timetable.iso(T0), "status": "Deployed",
                                             "starts_ticket": ""})
        with open(str(log.path_for(self.path)), "a") as f:
            f.write('{"kind": "che')
        self.advance(DAY)
        self.assertEqual([line["kind"] for line in self.lines()], ["look", "look", "check"])
        self.assertIn('{"kind": "che\n', self.log_bytes().decode())

    def test_reader_that_raises_is_unknown(self):
        self.plan()
        self.reading = RuntimeError("boom")
        self.advance(DAY)
        check = self.lines("check")[0]
        self.assertEqual(check["result"], "unknown")
        self.assertEqual(check["criteria"]["V1"]["result"], "unknown")

    def test_a_collector_with_no_reader_is_unknown(self):
        self.plan(criteria=[criterion(collector="weather", argument="today")])
        self.advance(DAY)
        self.assertEqual(self.lines("check")[0]["result"], "unknown")

    def test_a_reading_that_carries_text_is_not_logged(self):
        self.plan()
        self.reading = {"fields": {"last_exit": 0, "note": "Jane Doe, born 1 January 1970"}, "link": "x" * 400}
        self.advance(DAY)
        entry = self.lines("check")[0]["criteria"]["V1"]
        self.assertEqual(entry["fields"], {"last_exit": 0})
        self.assertLessEqual(len(entry["link"]), 300)

    def test_manual_criteria_are_not_read(self):
        self.plan(criteria=[criterion(), criterion("V2", manual=True)])
        self.advance(DAY)
        self.assertEqual(len(self.reads), 1)
        self.assertEqual(list(self.lines("check")[0]["criteria"]), ["V1"])

    def test_met_with_a_manual_criterion_is_needs_josh(self):
        self.plan(complete_n=1, criteria=[criterion(), criterion("V2", manual=True)])
        self.assertEqual(self.advance(DAY)[0], "needs_josh")

    def test_events_mode_waits_then_grades_once(self):
        checks = [{"field": "success", "comparison": "is at least", "value": 18}]
        self.plan(complete_kind="events", complete_n=20, complete_when="after 20 events",
                  criteria=[criterion(checks=checks, collector="ledger-runs", argument="non-development")])
        self.readers = {"ledger-runs": lambda a, s, d: self.reading}
        self.reading = {"fields": {"events": 12, "success": 12}, "link": ""}
        self.assertEqual(self.advance(DAY)[0], "pending")
        self.assertEqual(self.lines("check")[0]["result"], "waiting")
        self.reading = {"fields": {"events": 20, "success": 19}, "link": ""}
        outcome, outputs, _ = self.advance(DAY)
        self.assertEqual(outcome, "met")
        self.assertEqual(self.lines("check")[-1]["result"], "pass")
        self.assertEqual(self.lines()[-1]["reason"], "events")

    def test_missing_watch_file_stops_the_run(self):
        self.path = self.folder / "round-1.json"
        with self.assertRaises(GateError):
            self.call()

    def test_a_watch_file_that_is_not_json_stops_the_run(self):
        self.plan()
        self.path.write_text("{")
        with self.assertRaises(GateError):
            self.call()

    def test_default_readers_load_the_real_collectors(self):
        self.plan()
        reader = watch_round.default_reader("job")
        self.assertTrue(callable(reader))
        self.assertIsNone(watch_round.default_reader("reading"))
        self.assertIsNone(watch_round.default_reader("../etc"))
        self.assertIsNone(watch_round.default_reader("nothing-like-this"))


if __name__ == "__main__":
    unittest.main()
