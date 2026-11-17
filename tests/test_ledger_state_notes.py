"""JP-107, Task 6: notes copied from a made-up STATE.md in the harness template's shape."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ledger_helpers import FAKE_PHONE, NOW, LedgerCase  # noqa: E402
from ledger import state_notes  # noqa: E402

TEMPLATE_PLACEHOLDERS = """## Findings
- (finding: current state; told the user yes/no)

## U-turns
- (from -> to: why; told the user yes/no)

## Dead ends
- (approach: why it failed; do not retry)
"""

STATE = """# State (keep concise)

## Status
- Checkpoint done: made-up thing

## Findings
- the widget export drops a column; told the user yes
- the made-up cache is stale after midnight; told the user no
- another unreported oddity; Told The User No.

## U-turns
- plan A -> plan B: the sample API changed; told the user yes
- (from -> to: why; told the user yes/no)

## Dead ends
- retry with a longer timeout: it never helps; do not retry

## Timeline
- User request: made up
"""


class Notes(LedgerCase):
    def setUp(self):
        super().setUp()
        self.uid_ = self.session()
        self.episode(self.uid_, 1)
        self.episode(self.uid_, 2)
        self.file = self.tmp / "STATE.md"

    def put(self, text):
        self.file.write_text(text, encoding="utf-8")

    def copy(self, keeps=True, episode=1, file="default"):
        return state_notes.copy_notes(self.conn, self.file if file == "default" else file, self.uid_, episode,
                                      keeps, NOW)

    def test_state_md_sections_become_notes(self):
        self.put(STATE)
        self.assertEqual(self.copy(), 4)
        got = self.rows("SELECT kind, note FROM session_state_notes ORDER BY id")
        self.assertEqual(len([1 for k, _ in got if k == "untold-finding"]), 2)  # only the two that end "told the user no"
        self.assertEqual(len([1 for k, _ in got if k == "u-turn"]), 1)
        self.assertEqual(len([1 for k, _ in got if k == "dead-end"]), 1)

    def test_placeholders_only_gives_nothing(self):
        self.put(TEMPLATE_PLACEHOLDERS)
        self.assertEqual(self.copy(), 0)

    def test_each_note_is_cut_to_300(self):
        self.put("## Dead ends\n- " + "x" * 400 + "\n")
        self.copy()
        note = self.rows("SELECT note FROM session_state_notes")[0][0]
        self.assertEqual(len(note), 300)

    def test_patient_data_note_is_withheld_not_dropped(self):
        """Review Focus 5."""
        self.put("## Dead ends\n- called " + FAKE_PHONE + " to check; do not retry\n- an ordinary one\n")
        self.assertEqual(self.copy(), 2)
        notes = [n for (n,) in self.rows("SELECT note FROM session_state_notes ORDER BY id")]
        self.assertIn("withheld: patient data", notes)
        self.assertTrue(all(FAKE_PHONE not in n for n in notes))
        self.assertEqual(len(notes), 2)

    def test_phi_folder_stores_no_notes(self):
        """Review Focus 6."""
        self.put(STATE)
        self.assertEqual(self.copy(keeps=False), 0)
        self.assertEqual(self.count("session_state_notes"), 0)
        everything = "\n".join(self.conn.iterdump())
        self.assertNotIn("widget export", everything)

    def test_missing_state_md_writes_nothing(self):
        self.assertEqual(self.copy(file=self.tmp / "no-such" / "STATE.md"), 0)
        self.assertEqual(self.copy(file=None), 0)

    def test_a_second_copy_does_not_repeat_notes(self):
        self.put(STATE)
        self.copy()
        self.assertEqual(self.copy(episode=2), 0)
        self.put(STATE + "\n## Dead ends\n- a new one: it failed\n")
        self.assertEqual(self.copy(episode=2), 1)
        self.assertEqual(self.rows("SELECT episode FROM session_state_notes ORDER BY id DESC LIMIT 1"), [(2,)])

    def test_the_path_follows_the_harness_layout(self):
        self.assertEqual(state_notes.state_file("sess-0001", Path("/x/.claude")),
                         Path("/x/.claude/session-state/sess-0001/STATE.md"))


if __name__ == "__main__":
    unittest.main()
