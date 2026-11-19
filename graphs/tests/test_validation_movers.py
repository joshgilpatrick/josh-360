"""JP-168, Task 14: the movers' gate, their two comments and the close step's target. Made-up tickets only.

Run: python3 -m unittest discover -s graphs/tests -p "test_validation_movers.py"   (from the repository root)
"""
from __future__ import annotations

import unittest

from dev_helpers import DESCRIPTION, KEY, FakeGitHub, FakeTicket, Case, gate, make_dev_deps
from lib import dev_copy, nondev_copy
from lib.gate_run import GateError
from nondev_helpers import write_artifacts

RULE = gate("validation-rule")
CLOSE = gate("close-ticket")
URL = "https://github.com/josh/widgets/pull/7"

YES = """

**Validation:**

- Needed: yes
- Starts: at Deployed
- Check every: 1 day
- Complete when: 7 checks in a row pass
- Give up after: 21 days

```gherkin
@validate
Scenario: The widget job runs clean
  When the watch reads job widget-job
  Then last_exit is 0
```
"""

NO = """

**Validation:**

- Needed: no. The change is a document; nothing runs in production.
"""

BROKEN = YES.replace("Check every: 1 day", "Check every: daily")


def rule(description, key=KEY, status="Validation"):
    ticket = FakeTicket(key=key, description=description, status=status)
    deps = make_dev_deps(__import__("tempfile").mkdtemp(), ticket=ticket)
    return RULE.run({"ticket_key": key}, deps), ticket


class ValidationRule(unittest.TestCase):
    def test_rule_says_watch_for_a_jp_ticket_that_needs_one(self):
        (outcome, _, summary), ticket = rule(DESCRIPTION + YES)
        self.assertEqual(outcome, "watch")
        self.assertIn(KEY, summary)
        self.assertEqual((ticket.moves, ticket.posted, ticket.flags), ([], [], []))

    def test_rule_says_done_for_needed_no(self):
        self.assertEqual(rule(DESCRIPTION + NO)[0][0], "done")

    def test_rule_says_done_for_no_section(self):
        self.assertEqual(rule(DESCRIPTION)[0][0], "done")

    def test_rule_says_done_for_a_ticket_outside_jp(self):
        self.assertEqual(rule(DESCRIPTION + YES, key="AD-12")[0][0], "done")

    def test_rule_says_done_for_a_key_that_only_looks_like_jp(self):
        for key in ("JP-12\nAD-1", "XJP-12", "JP-x"):
            ticket = FakeTicket(key=key, description=DESCRIPTION + YES)
            out = RULE.run({"ticket_key": key}, make_dev_deps(__import__("tempfile").mkdtemp(), ticket=ticket))
            self.assertEqual(out[0], "done", key)

    def test_rule_says_watch_even_when_the_section_has_a_problem(self):
        # the graph's own first step asks Josh about a section it cannot read; the mover does not
        self.assertEqual(rule(DESCRIPTION + BROKEN)[0][0], "watch")

    def test_rule_with_an_unreadable_ticket_is_a_gate_error(self):
        ticket = FakeTicket(key=KEY, fail_on=["read"])
        with self.assertRaises(GateError):
            RULE.run({"ticket_key": KEY}, make_dev_deps(__import__("tempfile").mkdtemp(), ticket=ticket))

    def test_rule_with_no_key_is_a_gate_error(self):
        with self.assertRaises(GateError):
            RULE.run({"ticket_key": None}, make_dev_deps(__import__("tempfile").mkdtemp()))


class HandedToWatchCopy(unittest.TestCase):
    def test_development_copy_is_word_for_word(self):
        self.assertEqual(
            dev_copy.handed_to_watch(URL, "abcdef0", "run-1"),
            "Merged, now watched in production | merged https://github.com/josh/widgets/pull/7 as abcdef0 · "
            "spec and evidence saved with run run-1 | next gate: the validation watch starts within five minutes; "
            "the ticket is Done when its criteria are met")

    def test_non_development_copy_is_word_for_word(self):
        self.assertEqual(
            nondev_copy.handed_to_watch(),
            "Delivered, now watched in production | the resolution is in the comment above | "
            "next gate: the validation watch starts within five minutes")


class CloseDevelopmentTicket(Case):
    def setUp(self):
        super().setUp()
        self.github = FakeGitHub()
        self.github.state = "MERGED"
        self.github.merge_commit = "abcdef0123456789"
        self.ticket = FakeTicket(key=KEY)

    def close(self, **over):
        args = {"ticket_key": KEY, "ticket_type": "Story", "phi": "false", "pr_url": URL, "spec_path": None,
                "evidence_path": None, "deliverable_path": None}
        args.update(over)
        deps = make_dev_deps(self.root, ticket=self.ticket, github=self.github)
        return CLOSE.run(args, deps)

    def test_close_ticket_moves_to_deployed_when_told(self):
        outcome, _, _ = self.close(target_status="Deployed")
        self.assertEqual(outcome, "closed")
        self.assertEqual(self.ticket.moves, [(KEY, "Deployed")])
        self.assertEqual(self.ticket.posted[-1][1], dev_copy.handed_to_watch(URL, "abcdef0", "run-1"))

    def test_close_ticket_still_moves_to_done(self):
        self.close()
        self.assertEqual(self.ticket.moves, [(KEY, "Done")])
        self.assertEqual(self.ticket.posted[-1][1], dev_copy.done_merged(URL, "abcdef0", "run-1", False))

    def test_a_target_that_is_neither_done_nor_deployed_means_done(self):
        for target in ("Validation", "Cancelled", "", "deployed", "Done\nDeployed"):
            self.ticket.moves.clear()
            self.close(target_status=target)
            self.assertEqual(self.ticket.moves, [(KEY, "Done")], repr(target))

    def test_close_to_deployed_twice_comments_once(self):
        self.close(target_status="Deployed")
        self.close(target_status="Deployed")
        self.assertEqual(len(self.ticket.posted), 1)

    def test_an_unmerged_pull_request_is_not_handed_over(self):
        self.github.state = "OPEN"
        with self.assertRaises(GateError):
            self.close(target_status="Deployed")
        self.assertEqual((self.ticket.moves, self.ticket.posted), ([], []))


class CloseNonDevelopmentTicket(Case):
    def close(self, ticket, target=None):
        deliverable, evidence = write_artifacts(self.root)
        inputs = {"ticket_key": KEY, "phi": "false", "deliverable_path": str(deliverable),
                  "evidence_path": str(evidence)}
        if target:
            inputs["target_status"] = target
        return CLOSE.run(inputs, make_dev_deps(self.root, ticket=ticket))

    def test_signed_off_ticket_posts_the_resolution_then_the_hand_over(self):
        ticket = FakeTicket(key=KEY)
        self.assertEqual(self.close(ticket, "Deployed")[0], "closed")
        self.assertEqual(ticket.moves, [(KEY, "Deployed")])
        first, second = [text for _, text in ticket.posted]
        self.assertTrue(first.startswith("Resolution: "))
        self.assertEqual(second, nondev_copy.handed_to_watch())

    def test_run_again_after_a_failed_move_posts_each_comment_once(self):
        ticket = FakeTicket(key=KEY, fail_on=["move"])
        with self.assertRaises(GateError):
            self.close(ticket, "Deployed")
        ticket.fail_on = set()
        self.close(ticket, "Deployed")
        self.assertEqual(len(ticket.posted), 2)
        self.assertEqual(ticket.moves, [(KEY, "Deployed")])

    def test_without_a_target_the_ticket_goes_to_done_with_one_comment(self):
        ticket = FakeTicket(key=KEY)
        self.close(ticket)
        self.assertEqual(ticket.moves, [(KEY, "Done")])
        self.assertEqual(len(ticket.posted), 1)


if __name__ == "__main__":
    unittest.main()
