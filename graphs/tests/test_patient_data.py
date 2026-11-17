"""Tests for graphs/gates/lib/patient_data.py, the shared patient-data scan (JP-149).

Rule: docs/design/data-model.md, "Patient data". Every text here is made up.

Run: python3 -m unittest discover -s graphs/tests   (from the repository root)
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

GATES = Path(__file__).resolve().parent.parent / "gates"
sys.path.insert(0, str(GATES))

from lib import patient_data  # noqa: E402

WORK_TEXT = "JP-149 merged 2026-11-17, PR #24, 3 files, run 19234567890, commit 36abde1"


class TheIdentifierScreenMatchesJoshsList(unittest.TestCase):
    """JP-149 scenario: an SSN shape, a labelled date of birth or a phone number is withheld."""

    def test_ssn_shape(self):
        self.assertEqual(patient_data.screen("member 000-00-0000 called"), ["ssn-shape"])

    def test_labelled_date_of_birth(self):
        for text in ("DOB 03/04/1961", "dob: 1961-03-04", "date of birth 4 March 1961", "Born on 3/4/61"):
            self.assertIn("labelled-dob", patient_data.screen(text), text)

    def test_old_date_is_a_date_of_birth_net(self):
        self.assertEqual(patient_data.screen("seen 1961-03-04"), ["old-date"])
        self.assertEqual(patient_data.screen("seen 3/4/1961"), ["old-date"])

    def test_phone_number_shapes(self):
        for text in ("call 555-123-4567", "(555) 123-4567", "555.123.4567", "+1 555 123 4567"):
            self.assertEqual(patient_data.screen(text), ["phone"], text)

    def test_labelled_name(self):
        self.assertEqual(patient_data.screen("Patient: Jane Example"), ["labelled-name"])
        self.assertEqual(patient_data.screen("patient name Jane"), ["labelled-name"])

    def test_scan_withholds(self):
        self.assertTrue(patient_data.scan("call 555-123-4567", None, False))


class AUniqueIdentifierIsAllowedInTheLedger(unittest.TestCase):
    """JP-149 scenario: a record number and nothing else from Josh's list passes."""

    def test_labelled_record_number_passes(self):
        self.assertEqual(patient_data.screen("MRN 12345678"), [])
        self.assertEqual(patient_data.scan("fixed the import for patient id 4455667", None, False), [])

    def test_long_number_passes(self):
        self.assertEqual(patient_data.screen("record 12345678 reloaded"), [])

    def test_work_text_passes(self):
        self.assertEqual(patient_data.screen(WORK_TEXT), [])
        self.assertEqual(patient_data.screen(WORK_TEXT, external=True), [])

    def test_patient_as_a_word_passes(self):
        self.assertEqual(patient_data.screen("patient table: added an index"), [])


class GitHubAndJiraAreTheFirmGuard(unittest.TestCase):
    """For text written to GitHub or Jira, a labelled record number is a patient identifier too."""

    def test_labelled_record_number_is_refused_externally(self):
        for text in ("MRN 12345678", "medical record no. 4455", "patient id: 77", "Member ID 9988"):
            self.assertEqual(patient_data.screen(text, external=True), ["labelled-id"], text)

    def test_josh_list_still_applies_externally(self):
        self.assertEqual(patient_data.screen("000-00-0000", external=True), ["ssn-shape"])


class TheCopyCheck(unittest.TestCase):
    SOURCE = "Please look at the   chart for the March visit and the lab results."

    def test_a_copied_run_of_ten_characters_is_a_problem(self):
        self.assertEqual(patient_data.scan("about the chart for the Marc thing", self.SOURCE, False), ["copied-source"])

    def test_whitespace_is_collapsed_before_comparing(self):
        self.assertEqual(patient_data.scan("look at the chart", self.SOURCE, False), ["copied-source"])

    def test_nine_characters_are_not_a_copy(self):
        self.assertEqual(patient_data.scan("the March", self.SOURCE, False), [])

    def test_flagged_makes_every_text_a_problem(self):
        self.assertEqual(patient_data.scan("anything", None, True), ["flagged"])
        self.assertEqual(patient_data.scan("   ", None, True), [])

    def test_problems_never_hold_the_text(self):
        problems = patient_data.scan("DOB 03/04/1961 and 555-123-4567", None, False)
        self.assertEqual(problems, ["labelled-dob", "old-date", "phone"])
        for problem in problems:
            self.assertNotRegex(problem, r"\d")


if __name__ == "__main__":
    unittest.main()
