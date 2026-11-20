"""JP-191: the close-out gate the graph runner runs when a ticket's last step session closes. It moves the ticket to
Done only when no other gate has, and never moves a ticket in Deployed (its watch owns it) or Cancelled. Made-up
tickets only.

Run: python3 -m unittest discover -s graphs/tests -p "test_close_out_gate.py"   (from the repository root)
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from nondev_helpers import KEY, FakeTicket, gate, make_deps  # puts graphs/gates on the path first
from lib.gate_run import GateError  # noqa: E402

CLOSE_OUT = gate("close-out")


class CloseOut(unittest.TestCase):
    def run_gate(self, status, key=KEY, **ticket):
        self.ticket = FakeTicket(status=status, key=KEY, **ticket)
        with tempfile.TemporaryDirectory() as tmp:
            return CLOSE_OUT.run({"ticket_key": key}, make_deps(Path(tmp), ticket=self.ticket))

    def test_a_done_ticket_is_left_alone(self):
        self.assertEqual(self.run_gate("Done")[0], "already-done")
        self.assertEqual((self.ticket.moves, self.ticket.posted), ([], []))

    def test_deployed_and_cancelled_are_never_moved(self):
        for status in ("Deployed", "Cancelled"):
            outcome, _, summary = self.run_gate(status)
            self.assertEqual(outcome, "left", status)
            self.assertEqual((self.ticket.moves, self.ticket.posted), ([], []), status)
            self.assertIn(status, summary)

    def test_any_other_status_is_moved_to_done_with_one_comment(self):
        for status in ("In Progress", "Code Review", "Validation"):
            self.assertEqual(self.run_gate(status)[0], "moved", status)
            self.assertEqual(self.ticket.moves, [(KEY, "Done")], status)
            self.assertEqual([p[1] for p in self.ticket.posted], [CLOSE_OUT.COMMENT], status)

    def test_run_again_it_does_not_comment_twice(self):
        self.run_gate("In Progress", comments=[CLOSE_OUT.COMMENT])
        self.assertEqual(self.ticket.posted, [])
        self.assertEqual(self.ticket.moves, [(KEY, "Done")])

    def test_only_jp_tickets(self):
        with self.assertRaises(GateError):
            self.run_gate("In Progress", key="AD-12")
        with self.assertRaises(GateError):
            self.run_gate("In Progress", key="")

    def test_a_ticket_that_cannot_be_read_stops_the_gate(self):
        with self.assertRaises(GateError):
            self.run_gate("In Progress", fail_on=("read",))


if __name__ == "__main__":
    unittest.main()
