"""JP-199: the answers a Needs you card offers. A step above an ask may give an `options` output (a list of
{label, description}); the card shows those, then the ask's choices, and leaves the bare `answered` choice off.
Drives the walker's runner on the real graphs with a made-up run; no ledger, no Jira."""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "graphs" / "tools"))
from walker_lib import engine, graphfile, runner  # noqa: E402

RECOMMEND = {"label": "laptop/install.py", "description": "Recommended, because it holds STEPS."}


class FakeRun:
    """What `card_options` reads from a run: the graph and the saved step outputs."""

    def __init__(self, g, outputs=None):
        self.graph, self.state, self.values = g, engine.State(), {"ticket_key": "JP-9116"}
        self.doc = {"outputs": outputs or {}}


class CardOptions(unittest.TestCase):
    def setUp(self):
        self.triage = graphfile.load("triage", live_check=False)

    def options(self, outputs, step="ask_josh", g=None):
        return runner.card_options(FakeRun(g or self.triage, outputs), step)

    def test_offered_options_come_first_and_the_bare_answered_choice_is_left_off(self):
        got = self.options({"post_question": {"options": [RECOMMEND]}})
        self.assertEqual(got, [RECOMMEND, {"label": "park"}])

    def test_with_nothing_offered_the_card_shows_the_asks_choices(self):
        self.assertEqual(self.options({}), [{"label": "answered"}, {"label": "park"}])

    def test_options_from_a_step_that_is_not_above_the_ask_are_ignored(self):
        got = self.options({"post_question": {"options": [RECOMMEND]}}, step="ask_returned")
        self.assertEqual([o["label"] for o in got], ["answered", "park"])

    def test_a_bad_option_is_dropped_and_a_repeat_is_shown_once(self):
        offered = [RECOMMEND, dict(RECOMMEND), {"label": "  "}, {"label": "park"}, {"description": "no label"}, 7,
                   "scripts/check.py"]
        got = self.options({"post_question": {"options": offered}})
        self.assertEqual([o["label"] for o in got], ["laptop/install.py", "scripts/check.py", "park"])
        self.assertNotIn("description", got[1])

    def test_an_ask_without_the_answered_choice_offers_nothing(self):
        # A chosen option is the outcome `answered`; an ask that cannot take it would refuse the answer.
        got = self.options({"read_ticket": {"options": [RECOMMEND]}}, step="ask_at_limit")
        self.assertEqual([o["label"] for o in got], ["one_more_round", "park"])


if __name__ == "__main__":
    unittest.main()
