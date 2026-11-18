"""JP-166: the reading shape and the three collectors that read the laptop (job, report, doctor), on made-up files.

Run: python3 -m unittest discover -s graphs/tests   (from the repository root)
"""
from __future__ import annotations

import json
import math
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

GATES = Path(__file__).resolve().parent.parent / "gates"
sys.path.insert(0, str(GATES))
sys.path.insert(0, str(GATES.parent.parent))

from lib.collectors import doctor, job, reading, report  # noqa: E402

NOW = datetime(2026, 11, 18, 12, 0, 0, tzinfo=timezone.utc)
SINCE = "2026-11-17T12:00:00Z"
TEXT = "Jane Doe, born 1 January 1970, 555-0100"


class LaptopCase(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.home = Path(tmp.name)
        self.state = self.home / "state"
        (self.state / "reports").mkdir(parents=True)
        self.deps = SimpleNamespace(environ={"JOSH360_HOME": str(self.home)}, now=lambda: NOW)

    def put_json(self, rel: str, data, age_hours: float = 0.0) -> Path:
        path = self.state / rel
        path.write_text(json.dumps(data), encoding="utf-8")
        stamp = (NOW - timedelta(hours=age_hours)).timestamp()
        os.utime(str(path), (stamp, stamp))
        return path

    def nothing(self, fields):
        return {"fields": {name: None for name in fields}, "link": ""}


class ReadingTest(LaptopCase):
    def test_take_keeps_numbers_and_short_codes_only(self):
        kinds = {"a": "number", "b": "code", "c": "code", "d": "number", "e": "number", "f": "value", "g": "value"}
        raw = {"a": 3, "b": "pass", "c": "Jane Doe 1970-01-01", "d": True, "e": float("nan"), "f": [1], "g": 0.5}
        got = reading.take(raw, kinds)
        self.assertEqual(got["fields"], {"a": 3, "b": "pass", "c": None, "d": None, "e": None, "f": None, "g": 0.5})
        self.assertEqual(got["link"], "")

    def test_take_drops_a_code_with_a_trailing_newline(self):
        self.assertEqual(reading.take({"b": "pass\n"}, {"b": "code"})["fields"], {"b": None})
        self.assertFalse(reading.fits("pass\n", "code"))
        self.assertTrue(reading.fits("pass", "code"))

    def test_take_of_nothing_is_every_field_unknown(self):
        got = reading.take(None, {"a": "number", "b": "code"}, link="https://example.invalid/x")
        self.assertEqual(got["fields"], {"a": None, "b": None})

    def test_a_missing_field_is_unknown_and_an_extra_one_is_not_carried(self):
        got = reading.take({"a": 1, "extra": 2}, {"a": "number", "b": "number"})
        self.assertEqual(got["fields"], {"a": 1, "b": None})

    def test_numbers_that_are_not_finite_do_not_fit(self):
        self.assertFalse(reading.fits(math.inf, "number"))
        self.assertFalse(reading.fits(True, "number"))
        self.assertFalse(reading.fits("3", "number"))
        self.assertTrue(reading.fits(0, "value"))

    def test_state_dir_is_the_laptops(self):
        from laptop import common
        old = os.environ.get("JOSH360_HOME")
        os.environ["JOSH360_HOME"] = str(self.home)
        try:
            self.assertEqual(reading.state_dir(self.deps), common.state_dir())
        finally:
            if old is None:
                os.environ.pop("JOSH360_HOME")
            else:
                os.environ["JOSH360_HOME"] = old


class JobTest(LaptopCase):
    def test_job_reads_exit_and_age(self):
        last_run = (NOW - timedelta(minutes=90)).timestamp()
        self.put_json("jobs-state.json", {"sample-job": {"last_run": last_run, "last_result": 0}})
        got = job.read("sample-job", SINCE, self.deps)
        self.assertEqual(got["fields"], {"last_exit": 0, "hours_since_run": 1.5})

    def test_job_reads_a_failed_exit_code(self):
        self.put_json("jobs-state.json", {"sample-job": {"last_run": NOW.timestamp(), "last_result": 124}})
        self.assertEqual(job.read("sample-job", SINCE, self.deps)["fields"]["last_exit"], 124)

    def test_job_unknown_when_absent_or_unreadable(self):
        unknown = self.nothing(job.FIELDS)
        self.assertEqual(job.read("sample-job", SINCE, self.deps), unknown)            # no file
        (self.state / "jobs-state.json").write_text("{")
        self.assertEqual(job.read("sample-job", SINCE, self.deps), unknown)            # not JSON
        self.put_json("jobs-state.json", {"other-job": {"last_run": 1, "last_result": 0}})
        self.assertEqual(job.read("sample-job", SINCE, self.deps), unknown)            # not in it
        self.put_json("jobs-state.json", {"sample-job": {"last_run": "yesterday", "last_result": "ok"}})
        self.assertEqual(job.read("sample-job", SINCE, self.deps), unknown)            # text, not numbers
        self.put_json("jobs-state.json", ["sample-job"])
        self.assertEqual(job.read("sample-job", SINCE, self.deps), unknown)            # wrong shape

    def test_reader_refuses_a_trailing_newline(self):
        self.put_json("jobs-state.json", {"sample-job": {"last_run": NOW.timestamp(), "last_result": 0}})
        self.assertEqual(job.read("sample-job\n", SINCE, self.deps), self.nothing(job.FIELDS))
        self.assertEqual(job.read("../x", SINCE, self.deps), self.nothing(job.FIELDS))

    def test_job_declares_its_fields(self):
        self.assertEqual(job.FIELDS, {"last_exit": "number", "hours_since_run": "number"})
        self.assertFalse(job.COUNTS_EVENTS)


class ReportTest(LaptopCase):
    def test_report_reads_a_dotted_path(self):
        self.put_json("reports/doctor.json", {"summary": {"fail": 2}}, age_hours=0.25)
        got = report.read("doctor summary.fail", SINCE, self.deps)
        self.assertEqual(got["fields"]["value"], 2)
        self.assertAlmostEqual(got["fields"]["age_hours"], 0.25, places=2)
        self.assertEqual(got["link"], "reports/doctor.json on the laptop-status branch")

    def test_report_value_that_is_text_is_unknown(self):
        self.put_json("reports/doctor.json", {"summary": {"fail": "two failures in atlas", "ok": TEXT, "flag": True}})
        for path in ("summary.fail", "summary.ok", "summary.flag", "summary", "summary.missing"):
            self.assertIsNone(report.read("doctor " + path, SINCE, self.deps)["fields"]["value"], path)

    def test_report_value_can_be_a_short_code(self):
        self.put_json("reports/doctor.json", {"summary": {"state": "pass"}})
        self.assertEqual(report.read("doctor summary.state", SINCE, self.deps)["fields"]["value"], "pass")

    def test_report_path_does_not_go_through_lists(self):
        self.put_json("reports/doctor.json", {"checks": [{"id": "x"}]})
        self.assertIsNone(report.read("doctor checks.0.id", SINCE, self.deps)["fields"]["value"])

    def test_report_path_stays_in_the_reports_folder(self):
        self.put_json("jobs-state.json", {"x": 1})
        outside = self.home / "outside.json"
        outside.write_text("1")
        for argument in ("../jobs-state x", "doctor a..b", "../../outside x", "doctor ..", "/etc/passwd x"):
            self.assertEqual(report.read(argument, SINCE, self.deps), self.nothing(report.FIELDS), argument)

    def test_report_unknown_when_there_is_no_copy(self):
        self.assertEqual(report.read("doctor summary.fail", SINCE, self.deps), self.nothing(report.FIELDS))

    def test_report_refuses_a_trailing_newline(self):
        self.put_json("reports/doctor.json", {"summary": {"fail": 0}})
        self.assertEqual(report.read("doctor summary.fail\n", SINCE, self.deps), self.nothing(report.FIELDS))


class DoctorTest(LaptopCase):
    def doctor_report(self, age_hours=1.0, status="pass"):
        when = (NOW - timedelta(hours=age_hours)).strftime("%Y-%m-%dT%H:%M:%SZ")
        self.put_json("reports/doctor.json", {"time": when, "checks": [
            {"id": "backfills.retire-session-atlas", "status": status, "detail": TEXT},
            {"id": "services.atlas-launchd", "status": "warn", "detail": TEXT}]})

    def test_doctor_reads_a_check_status(self):
        self.doctor_report()
        got = doctor.read("backfills.retire-session-atlas", SINCE, self.deps)
        self.assertEqual(got["fields"], {"status": "pass"})
        self.assertEqual(got["link"], "reports/doctor.json on the laptop-status branch")

    def test_doctor_older_than_36_hours_is_unknown(self):
        self.doctor_report(age_hours=36.5)
        self.assertEqual(doctor.read("backfills.retire-session-atlas", SINCE, self.deps), self.nothing(doctor.FIELDS))
        self.doctor_report(age_hours=35.5)
        self.assertEqual(doctor.read("backfills.retire-session-atlas", SINCE, self.deps)["fields"]["status"], "pass")

    def test_doctor_unknown_check_id_is_unknown(self):
        self.doctor_report()
        self.assertEqual(doctor.read("backfills.nothing-here", SINCE, self.deps), self.nothing(doctor.FIELDS))

    def test_doctor_report_with_no_time_or_a_bad_one_is_unknown(self):
        self.put_json("reports/doctor.json", {"checks": [{"id": "a.b", "status": "pass"}]})
        self.assertEqual(doctor.read("a.b", SINCE, self.deps), self.nothing(doctor.FIELDS))
        self.put_json("reports/doctor.json", {"time": "yesterday", "checks": [{"id": "a.b", "status": "pass"}]})
        self.assertEqual(doctor.read("a.b", SINCE, self.deps), self.nothing(doctor.FIELDS))

    def test_doctor_status_that_is_text_is_unknown(self):
        self.doctor_report(status=TEXT)
        self.assertEqual(doctor.read("backfills.retire-session-atlas", SINCE, self.deps)["fields"], {"status": None})

    def test_doctor_refuses_a_trailing_newline(self):
        self.doctor_report()
        self.assertEqual(doctor.read("backfills.retire-session-atlas\n", SINCE, self.deps),
                         self.nothing(doctor.FIELDS))


if __name__ == "__main__":
    unittest.main()
