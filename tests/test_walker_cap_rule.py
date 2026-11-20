"""JP-194: the run cap stops a role step only when that step is the next to start, not every loop that leads to it.

Drives the walker's engine on the real triage graph (graphs/compiled/triage.json), as JP-116's run r-4400caa5965b went:
the drafter used its whole cap, its last attempt revised the ticket, and apply_revision looped back to read_ticket.
Made-up outcomes only; no ledger, no Jira.
"""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "graphs" / "tools"))
from walker_lib import engine, graphfile  # noqa: E402


def triage():
    return graphfile.load("triage", live_check=False)


def walk(g, st, outcomes, rows=None, stop_at_ask=True):
    """Feed outcomes (step -> list) until the run asks, ends or has no outcome left. Returns the last action."""
    queue = {k: list(v) for k, v in outcomes.items()}
    while True:
        act = engine.decide(g, st)
        if act.kind in ("done", "exit", "stopped") or (act.kind == "ask" and stop_at_ask):
            return act
        if not queue.get(act.step):
            return act
        out = queue[act.step].pop(0)
        engine.begin(g, st, act.step, allowed=act.allowed)
        if rows is not None:
            rows.append({"step": act.step, "attempt": st.runs[act.step], "outcome": out, "allowed": act.allowed})
        engine.finish(g, st, act.step, out)


def revise_at_cap(g, st, rows=None):
    """The ready check finds gaps and the drafter runs as often as its mid cap allows (3): two attempts where the model
    ran and the step failed (abandoned, JP-183's `ran` kind), then one that revises, as in JP-116's run."""
    cap = g.cap("revise")
    assert cap == 3, cap
    return walk(g, st, {"read_ticket": ["read"], "ready_check": ["gaps"], "verdict": ["revise"],
                        "revise": [engine.ABANDONED, engine.ABANDONED, "revised"]}, rows)


class CapHeldAtTheStep(unittest.TestCase):
    def test_a_loop_back_to_a_re_read_goes_ahead_when_the_capped_drafter_would_not_run(self):
        g, st = triage(), engine.State()
        st.entered = True
        act = revise_at_cap(g, st)
        self.assertEqual((act.kind, act.step), ("gate", "apply_revision"))
        self.assertEqual(st.runs["revise"], 3)
        engine.begin(g, st, "apply_revision")
        engine.finish(g, st, "apply_revision", "applied")
        self.assertIsNone(st.forced, "the loop back to read_ticket must not be refused for the drafter's cap")
        act = walk(g, st, {"read_ticket": ["read"], "ready_check": ["pass"], "route": ["development"],
                           "sign_off": ["ready"], "check_sign_off": ["ready"], "verdict": ["ready"]})
        self.assertEqual((act.kind, act.step), ("gate", "mark_ready"))
        self.assertEqual(st.runs["revise"], 3)          # the drafter never started a fourth time

    def test_the_capped_step_is_next_so_the_loop_s_ask_comes_first(self):
        g, st = triage(), engine.State()
        st.entered = True
        revise_at_cap(g, st)
        engine.begin(g, st, "apply_revision")
        engine.finish(g, st, "apply_revision", "applied")
        act = walk(g, st, {"read_ticket": ["read"], "ready_check": ["gaps"], "verdict": ["revise"]})
        self.assertEqual((act.kind, act.step), ("ask", "ask_at_limit"))
        self.assertEqual((act.forced.reason, act.forced.from_step, act.forced.steps), ("cap", "apply_revision", ("revise",)))
        engine.begin(g, st, "ask_at_limit")
        engine.finish(g, st, "ask_at_limit", "one_more_round")
        act = walk(g, st, {"read_ticket": ["read"], "ready_check": ["gaps"], "verdict": ["revise"]})
        self.assertEqual((act.kind, act.step, act.allowed), ("run", "revise", True))   # Josh's yes is one more run

    def test_the_loop_limit_is_still_checked_when_the_loop_fires(self):
        g, st = triage(), engine.State()
        st.entered = True
        st.loops[("apply_revision", "read_ticket")] = 2
        walk(g, st, {"read_ticket": ["read"], "ready_check": ["gaps"], "verdict": ["revise"], "revise": ["revised"]})
        engine.begin(g, st, "apply_revision")
        engine.finish(g, st, "apply_revision", "applied")
        self.assertEqual((st.forced.ask, st.forced.reason), ("ask_at_limit", "loop"))

    def test_a_replay_rebuilds_the_same_run(self):
        g, st, rows = triage(), engine.State(), [{"step": "_entry", "attempt": 1, "outcome": "pass", "allowed": False}]
        st.entered = True
        revise_at_cap(g, st, rows)
        walk(g, st, {"apply_revision": ["applied"], "read_ticket": ["read"], "ready_check": ["gaps"],
                     "verdict": ["revise"]}, rows)
        again = engine.replay(g, rows)
        act = engine.decide(g, again)
        self.assertEqual((act.kind, act.step, act.forced.reason), ("ask", "ask_at_limit", "cap"))


class OlderLedgers(unittest.TestCase):
    def test_a_run_recorded_before_jp_194_still_replays(self):
        # JP-116's run: the older walker went to ask_at_limit straight after apply_revision, without taking the loop.
        g, rows = triage(), [{"step": "_entry", "attempt": 1, "outcome": "pass", "allowed": False}]
        st = engine.State()
        st.entered = True
        revise_at_cap(g, st, rows)
        rows.append({"step": "apply_revision", "attempt": 1, "outcome": "applied", "allowed": False})
        rows.append({"step": "ask_at_limit", "attempt": 1, "outcome": None, "allowed": False})
        st = engine.replay(g, rows)
        self.assertEqual(st.open_step, "ask_at_limit")
        self.assertEqual((st.forced.ask, st.forced.reason), ("ask_at_limit", "cap"))
        self.assertNotIn(("apply_revision", "read_ticket"), {k for k, v in st.loops.items() if v >= 3})
        # Josh answers one more round on the laptop; the rest of the run replays under the new rule.
        rows[-1]["outcome"] = "one_more_round"
        st = engine.replay(g, rows)
        act = walk(g, st, {"read_ticket": ["read"], "ready_check": ["gaps"], "verdict": ["revise"]})
        self.assertEqual((act.kind, act.step, act.allowed), ("run", "revise", True))


if __name__ == "__main__":
    unittest.main()
