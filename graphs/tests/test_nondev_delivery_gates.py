"""JP-123, Task 5: deliver, sign-off-rule and share. Made-up tickets, a fake mailer and a fake draft tool."""
import unittest
from pathlib import Path

from nondev_helpers import KEY, Case, FakeTicket, gate, write_artifacts
from lib.gate_run import GateError

DELIVER = gate("deliver")
RULE = gate("sign-off-rule")
SHARE = gate("share")


class Deliver(Case):
    def deliver(self, origin="ticket", run_phi="false", mail_code=0, ticket=None, **art):
        deliverable, evidence = write_artifacts(self.root, **art)
        deps = self.deps(ticket=ticket or FakeTicket(), mail_code=mail_code)
        inputs = {"ticket_key": KEY, "origin": origin, "desk_row": "42" if origin == "email" else "none", "phi": run_phi,
                  "deliverable_path": str(deliverable), "evidence_path": str(evidence)}
        return DELIVER.run(inputs, deps), deps, deliverable, evidence

    def test_deliver_comment_copy(self):
        (outcome, outputs, _), deps, deliverable, evidence = self.deliver()
        self.assertEqual(outcome, "delivered")
        expected = ("Deliverable ready | Two counts: 40 filed, 31 closed. · {} · evidence {} | "
                    "next gate: Josh's sign-off").format(deliverable, evidence)
        self.assertEqual(deps.ticket.posted, [(KEY, expected)])
        self.assertEqual(outputs["card"], expected)
        self.assertEqual(deps.mails, [])          # a ticket-origin run sends nothing

    def test_deliver_withholds_summary_when_phi(self):
        (_, _, _), deps, deliverable, _ = self.deliver(run_phi="true", summary="Jane Roe had 3 visits")
        text = deps.ticket.posted[0][1]
        self.assertIn("Deliverable ready | summary withheld: patient data · " + str(deliverable), text)
        self.assertNotIn("Jane", text)

    def test_evidence_phi_flag_withholds_even_when_the_run_says_false(self):
        (_, _, _), deps, _, _ = self.deliver(run_phi="false", summary="Jane Roe had 3 visits", phi=True)
        self.assertNotIn("Jane", deps.ticket.posted[0][1])

    def test_deliver_email_calls_mailer_with_row(self):
        (_, _, _), deps, deliverable, evidence = self.deliver(origin="email")
        self.assertEqual(len(deps.mails), 1)
        argv = deps.mails[0]
        self.assertEqual(argv[:3], ["reply", "--row", "42"])
        self.assertEqual(argv[-2:], ["--kind", "answer"])
        body = Path(argv[argv.index("--body-file") + 1]).read_text()
        self.assertIn("Two counts: 40 filed, 31 closed.", body)
        self.assertIn(str(deliverable), body)

    def test_email_body_is_paths_only_when_phi(self):
        (_, _, _), deps, deliverable, _ = self.deliver(origin="email", run_phi="true", summary="Jane Roe had 3 visits")
        body = Path(deps.mails[0][deps.mails[0].index("--body-file") + 1]).read_text()
        self.assertNotIn("Jane", body)
        self.assertIn("summary withheld: patient data", body)
        self.assertIn(str(deliverable), body)

    def test_deliver_mailer_exit_4_is_success(self):
        (outcome, _, _), _, _, _ = self.deliver(origin="email", mail_code=4)
        self.assertEqual(outcome, "delivered")

    def test_deliver_mailer_exit_7_fails(self):
        with self.assertRaises(GateError) as caught:
            self.deliver(origin="email", mail_code=7)
        self.assertIn("exited 7", str(caught.exception))

    def test_run_again_after_a_mailer_failure_does_not_repeat_the_comment(self):
        ticket = FakeTicket()
        with self.assertRaises(GateError):
            self.deliver(origin="email", mail_code=6, ticket=ticket)
        self.deliver(origin="email", mail_code=4, ticket=ticket)
        self.assertEqual(len(ticket.posted), 1)

    def test_email_origin_without_a_desk_row_stops_the_run(self):
        deliverable, evidence = write_artifacts(self.root)
        inputs = {"ticket_key": KEY, "origin": "email", "desk_row": "none", "phi": "false",
                  "deliverable_path": str(deliverable), "evidence_path": str(evidence)}
        with self.assertRaises(GateError):
            DELIVER.run(inputs, self.deps())

    def test_patient_shaped_summary_is_refused(self):
        with self.assertRaises(GateError):
            self.deliver(summary="Patient: Jane Roe, SSN 123-45-6789")


class SignOffRule(Case):
    def test_sign_off_rule_email(self):
        self.assertEqual(RULE.run({"origin": "email"}, self.deps())[0], "emailed")

    def test_sign_off_rule_ticket(self):
        self.assertEqual(RULE.run({"origin": "ticket"}, self.deps())[0], "ask_josh")
        self.assertEqual(RULE.run({"origin": None}, self.deps())[0], "ask_josh")


class Share(Case):
    def share(self, run_phi="false", **art):
        deliverable, evidence = write_artifacts(self.root, **art)
        deps = self.deps()
        inputs = {"ticket_key": KEY, "phi": run_phi, "deliverable_path": str(deliverable), "evidence_path": str(evidence)}
        return SHARE.run(inputs, deps), deps, deliverable

    def test_share_refuses_phi(self):
        (outcome, _, _), deps, _ = self.share(run_phi="true", recipient="sam@example.com")
        self.assertEqual(outcome, "refused")
        self.assertEqual((deps.drafts, deps.ticket.posted), ([], []))

    def test_share_refuses_phi_flagged_only_in_the_evidence(self):
        (outcome, _, _), deps, _ = self.share(run_phi="false", recipient="sam@example.com", phi=True)
        self.assertEqual((outcome, deps.drafts), ("refused", []))

    def test_share_drafts_never_sends(self):
        (outcome, _, _), deps, deliverable = self.share(recipient="sam@example.com")
        self.assertEqual(outcome, "shared")
        self.assertEqual(deps.drafts, [("sam@example.com", "JP-9001: JP-9001-answer.md", deliverable)])
        self.assertFalse(hasattr(deps, "send_email"))            # nothing on deps can send
        self.assertEqual(deps.ticket.posted, [(KEY, "Shared | sam@example.com | next gate: close")])
        self.assertEqual(deps.mails, [])                        # the desk mailer is not used either

    def test_share_comments_on_non_jp_ticket(self):
        (outcome, _, _), deps, _ = self.share(recipient="AD-77")
        self.assertEqual(outcome, "shared")
        self.assertEqual([k for k, _ in deps.ticket.posted], ["AD-77", KEY])
        self.assertIn("JP-9001 deliverable ready |", deps.ticket.posted[0][1])
        self.assertEqual(deps.drafts, [])

    def test_share_refuses_unknown_recipient(self):
        for recipient in ("none", "Sam from finance", "JP-9000", ""):
            (outcome, _, _), deps, _ = self.share(recipient=recipient)
            self.assertEqual(outcome, "refused", recipient)
            self.assertEqual((deps.drafts, deps.ticket.posted), ([], []))

    def test_a_missing_draft_tool_stops_the_run(self):
        deliverable, evidence = write_artifacts(self.root, recipient="sam@example.com")

        def no_tool(*args):
            raise GateError("no draft tool")
        deps = self.deps(draft_email=no_tool)
        with self.assertRaises(GateError):
            SHARE.run({"ticket_key": KEY, "phi": "false", "deliverable_path": str(deliverable),
                       "evidence_path": str(evidence)}, deps)
        self.assertEqual(deps.ticket.posted, [])


if __name__ == "__main__":
    unittest.main()
