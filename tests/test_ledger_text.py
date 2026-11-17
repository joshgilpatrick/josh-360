"""JP-107, Task 2: safe short text. Made-up strings only."""
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ledger_helpers import FAKE_DOB, FAKE_MRN, FAKE_PHONE, FAKE_SSN, ROOT  # noqa: E402
from ledger import text  # noqa: E402

SCHEMA = (ROOT / "ledger" / "schema.sql").read_text(encoding="utf-8")


def table_sql(name):
    m = re.search(r"CREATE TABLE {} \(.*?\n\);".format(name), SCHEMA, re.DOTALL)
    return m.group(0)


class ShortText(unittest.TestCase):
    def test_long_title_is_cut_to_its_cap(self):
        out, withheld = text.short_text("x" * 130, 120)
        self.assertEqual(len(out), 120)
        self.assertTrue(out.endswith("…"))
        self.assertFalse(withheld)

    def test_text_at_the_cap_is_not_cut(self):
        out, _ = text.short_text("y" * 120, 120)
        self.assertEqual(out, "y" * 120)

    def test_line_breaks_become_spaces_when_one_line(self):
        self.assertEqual(text.short_text("one\n two\t\tthree", 50)[0], "one two three")

    def test_line_breaks_stay_when_not_one_line(self):
        self.assertEqual(text.short_text("one\ntwo", 50, one_line=False)[0], "one\ntwo")

    def test_phi_withholds(self):
        self.assertEqual(text.short_text("ordinary words", 50, phi=True), (text.WITHHELD, True))

    def test_copied_source_run_withholds(self):
        source = "the made-up source sentence is long enough"
        self.assertEqual(text.short_text("quoting: made-up source sentence", 80, source_text=source),
                         (text.WITHHELD, True))

    def test_empty_is_none(self):
        for empty in (None, "", "   \n"):
            self.assertEqual(text.short_text(empty, 10), (None, False))

    def test_screen_withholds_joshs_list(self):
        for bad in (FAKE_SSN, FAKE_DOB, FAKE_PHONE, "Patient: Jane"):
            self.assertEqual(text.short_text("see " + bad + " here", 80), (text.WITHHELD, True), bad)

    def test_a_phone_number_cannot_slip_past_the_cut(self):
        self.assertEqual(text.short_text("z" * 110 + " " + FAKE_PHONE, 120), (text.WITHHELD, True))

    def test_record_number_is_stored(self):
        self.assertEqual(text.short_text(FAKE_MRN, 50), (FAKE_MRN, False))

    def test_work_text_is_stored(self):
        line = "JP-148 merged 2026-11-17, PR #24, 3 files"
        self.assertEqual(text.short_text(line, 80), (line, False))


class Caps(unittest.TestCase):
    def test_caps_match_the_schema(self):
        for (table, column), cap in text.CAPS.items():
            sql = table_sql(table)
            self.assertRegex(sql, r"length\({}\)[^,\n]*?\b{}\b".format(column, cap), (table, column))

    def test_twelve_columns(self):
        self.assertEqual(len(text.CAPS), 12)


if __name__ == "__main__":
    unittest.main()
