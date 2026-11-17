"""JP-123, Task 4: move-ticket, return-to-triage and close-ticket. Made-up tickets only."""
import unittest

from nondev_helpers import KEY, Case, FakeTicket, gate, write_artifacts
from lib.gate_run import GateError

MOVE = gate("move-ticket")
RETURN = gate("return-to-triage")
CLOSE = gate("close-ticket")


class MoveTicket(Case):
    def test_moves_to_the_target_status(self):
        ticket = FakeTicket()
        out = MOVE.run({"ticket_key": KEY, "target_status": "In Progress"}, self.deps(ticket=ticket))
        self.assertEqual(out[0], "moved")
        self.assertEqual(ticket.moves, [(KEY, "In Progress")])

    def test_unconfirmed_move_stops_the_run(self):
        with self.assertRaises(GateError):
            MOVE.run({"ticket_key": KEY, "target_status": "Done"}, self.deps(ticket=FakeTicket(fail_on=["move"])))

    def test_only_jp_tickets_and_known_statuses(self):
        ticket = FakeTicket()
        for inputs in ({"ticket_key": "AD-1", "target_status": "Done"}, {"ticket_key": KEY, "target_status": "Shipped"},
                       {"ticket_key": KEY, "target_status": None}):
            with self.assertRaises(GateError):
                MOVE.run(inputs, self.deps(ticket=ticket))
        self.assertEqual(ticket.moves, [])


class ReturnToTriage(Case):
    def test_return_comments_moves_and_flags(self):
        ticket = FakeTicket()
        out = RETURN.run({"ticket_key": KEY, "reason": "the ticket is not Ready"}, self.deps(ticket=ticket))
        self.assertEqual(out[0], "returned")
        self.assertEqual(ticket.moves, [(KEY, "Not Started")])
        self.assertEqual(ticket.flags, [(KEY, True)])
        self.assertEqual(ticket.posted, [(KEY, "Returned to triage | the ticket is not Ready | next gate: triage")])

    def test_default_reason_is_the_needs_code_one(self):
        ticket = FakeTicket()
        RETURN.run({"ticket_key": KEY, "reason": None}, self.deps(ticket=ticket))
        self.assertIn("needs code changes", ticket.posted[0][1])

    def test_a_ticket_outside_jp_is_left_untouched(self):
        ticket = FakeTicket()
        out = RETURN.run({"ticket_key": "AD-12", "reason": "the ticket is not in JP"}, self.deps(ticket=ticket))
        self.assertEqual(out[0], "returned")
        self.assertEqual((ticket.moves, ticket.flags, ticket.posted), ([], [], []))

    def test_run_again_does_not_repeat_the_comment(self):
        ticket = FakeTicket()
        inputs = {"ticket_key": KEY, "reason": "the ticket is not Ready"}
        RETURN.run(inputs, self.deps(ticket=ticket))
        RETURN.run(inputs, self.deps(ticket=ticket))
        self.assertEqual(len(ticket.posted), 1)

    def test_failed_move_stops_before_the_comment(self):
        ticket = FakeTicket(fail_on=["move"])
        with self.assertRaises(GateError):
            RETURN.run({"ticket_key": KEY, "reason": "x"}, self.deps(ticket=ticket))
        self.assertEqual(ticket.posted, [])


class CloseTicket(Case):
    def close(self, ticket=None, run_phi="false", **art):
        deliverable, evidence = write_artifacts(self.root, **art)
        ticket = ticket or FakeTicket()
        out = CLOSE.run({"ticket_key": KEY, "phi": run_phi, "deliverable_path": str(deliverable),
                         "evidence_path": str(evidence)}, self.deps(ticket=ticket))
        return out, ticket, deliverable

    def test_close_posts_resolution_shape(self):
        out, ticket, deliverable = self.close()
        self.assertEqual(out[0], "closed")
        self.assertEqual(ticket.moves, [(KEY, "Done")])
        self.assertEqual(ticket.posted[0][1],
                         "Resolution: How many were filed and closed? | 40 filed and 31 closed within a week. | "
                         "sources: JP-9001-query-1.sql, JP-9000 | deliverable: {} | next gate: none".format(deliverable))

    def test_resolution_without_a_bar_takes_the_question_from_the_ticket(self):
        out, ticket, _ = self.close(resolution="40 filed and 31 closed.")
        self.assertTrue(ticket.posted[0][1].startswith(
            "Resolution: How many open widgets were filed last quarter, and how many were closed within a week? | 40 filed"))

    def test_close_withholds_when_phi_even_if_summary_filled(self):
        out, ticket, deliverable = self.close(run_phi="true", summary="Jane Roe had 3 visits", resolution="Q | Jane's answer")
        text = ticket.posted[0][1]
        self.assertTrue(text.startswith("Resolution: withheld: patient data | withheld: patient data | sources: "))
        self.assertNotIn("Jane", text)
        self.assertIn("deliverable: " + str(deliverable), text)

    def test_evidence_flag_alone_also_withholds(self):
        out, ticket, _ = self.close(run_phi="false", phi=True)
        self.assertIn("withheld: patient data | withheld: patient data", ticket.posted[0][1])

    def test_close_transition_failure_stops_the_run(self):
        ticket = FakeTicket(fail_on=["move"])
        with self.assertRaises(GateError):
            self.close(ticket=ticket)
        self.assertEqual(len(ticket.posted), 1)   # the comment went; a run again will not repeat it

    def test_run_again_after_a_failed_move_posts_once(self):
        ticket = FakeTicket(fail_on=["move"])
        with self.assertRaises(GateError):
            self.close(ticket=ticket)
        ticket.fail_on = set()
        self.close(ticket=ticket)
        self.assertEqual(len(ticket.posted), 1)
        self.assertEqual(ticket.moves, [(KEY, "Done")])

    def test_patient_shaped_text_in_a_non_phi_resolution_is_refused(self):
        with self.assertRaises(GateError) as caught:
            self.close(resolution="Q | call 555-123-4567 about MRN 998877")
        self.assertIn("patient-data screen", str(caught.exception))
        self.assertNotIn("555", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
