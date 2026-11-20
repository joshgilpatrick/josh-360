"""The graph logic: what step is next, and what an outcome does. Pure functions, no files, no ledger.

The run state is rebuilt by replaying the run's step rows in order (`replay`), so nothing lives in a process.
The rules are the ones in graphs/CONVENTION.md, "How a graph runs" and "The run cap"; docs/superpowers/specs/
2026-11-17-walker-design.md says how the walker holds them.
"""
from __future__ import annotations

from typing import Dict, FrozenSet, List, NamedTuple, Optional, Set, Tuple

from .graphfile import Graph

ENTRY = "_entry"
EXIT = "_exit"
ABANDONED = "_abandoned"
ERROR = "_error"
RESERVED_OUTCOMES = (ABANDONED, ERROR)


class Corrupt(Exception):
    """The ledger's rows do not fit the graph. The walker stops and changes nothing."""


class Forced(NamedTuple):
    ask: str          # the at_limit ask the run was sent to
    reason: str       # 'loop' (the arrow is at its limit) or 'cap' (a role step is at its tier's run cap)
    from_step: str    # the step whose outcome took the loop
    outcome: str
    steps: Tuple[str, ...] = ()   # for 'cap': the role step at its cap that was about to start (JP-194)


class Held(NamedTuple):
    forced: Forced
    loop: Tuple[str, str]        # the loop's (from step, to step)
    done: Dict[str, str]         # st.done before the loop was taken
    skipped: FrozenSet[str]      # st.skipped before the loop was taken


class Action(NamedTuple):
    kind: str         # done, run, gate, wait, ask, exit, stopped
    step: Optional[str] = None
    allowed: bool = False       # a run past the cap that Josh allowed
    forced: Optional[Forced] = None
    reason: str = ""


class State:
    def __init__(self) -> None:
        self.done: Dict[str, str] = {}
        self.skipped: Set[str] = set()
        self.runs: Dict[str, int] = {}                    # step -> starts so far
        self.loops: Dict[Tuple[str, str], int] = {}       # (from step, to step) -> trips, never reset
        self.consumed: Dict[str, int] = {}                # runs past the cap that Josh allowed, already started
        self.grants: Dict[str, int] = {}                  # runs past the cap Josh allowed, not started yet
        self.forced: Optional[Forced] = None
        # JP-194: a loop that reset a role step already at its cap is still taken. The ask that loop names waits here,
        # per step, with the done and skipped steps as they were before the loop, and the run goes to it only when that
        # step is the next one to start.
        self.cap_asks: Dict[str, Held] = {}
        # The newest such loop, kept until the next step starts. replay() uses it for a ledger a walker from before
        # JP-194 wrote, which has the ask straight after the loop step (that walker went to the ask at once).
        self.eager: Optional[Held] = None
        self.ended: Optional[str] = None
        self.open_step: Optional[str] = None              # started, no result yet
        self.entered = False


def _when_matches(st: State, when: dict) -> bool:
    src = when["step"]
    want = when["outcome"]
    want = want if isinstance(want, list) else [want]
    return src not in st.skipped and st.done.get(src) in want


def ready_step(g: Graph, st: State) -> Optional[str]:
    """The first step in file order that can run now. A step whose `when` does not match is skipped on the way."""
    progressed = True
    while progressed:
        progressed = False
        for sid in g.order:
            if sid in st.done or sid in st.skipped or g.on_limit_only(sid):
                continue
            if not all(n in st.done or n in st.skipped for n in g.needs(sid)):
                continue
            when = g.steps[sid].get("when")
            if when and not _when_matches(st, when):
                st.skipped.add(sid)
                progressed = True
                break
            return sid
    return None


def _over_cap(g: Graph, st: State, step: str) -> bool:
    cap = g.cap(step)
    return cap is not None and st.runs.get(step, 0) + 1 > cap + st.consumed.get(step, 0)


def decide(g: Graph, st: State) -> Action:
    if st.ended:
        return Action("done")
    if st.forced:
        return Action("ask", st.forced.ask, forced=st.forced)
    step = ready_step(g, st)
    if step is None:
        return Action("exit")
    kind = g.kind(step)
    if kind == "role" and _over_cap(g, st, step):
        if st.grants.get(step, 0) > 0:
            return Action("run", step, allowed=True)
        held = st.cap_asks.get(step)
        if held is not None:
            # The capped step would start now, so the loop that reset it names the question (JP-194). The run is put
            # back as it stood when that loop was taken, so an answer that moves on carries on from there.
            _hold(st, held)
            st.forced = held.forced._replace(steps=(step,))
            return Action("ask", st.forced.ask, forced=st.forced)
        return Action("stopped", step, reason="step '{}' has run as often as its tier allows ({} runs) and no "
                      "question leads to a decision; use `allow` to allow one more".format(step, g.cap(step)))
    return Action("run" if kind == "role" else kind, step)


def _hold(st: State, held: Held) -> None:
    st.done, st.skipped = dict(held.done), set(held.skipped)


def begin(g: Graph, st: State, step: str, allowed: bool = False) -> int:
    """A step starts. Returns its attempt number."""
    st.runs[step] = st.runs.get(step, 0) + 1
    st.cap_asks.pop(step, None)
    st.eager = None
    if allowed:
        st.consumed[step] = st.consumed.get(step, 0) + 1
        st.grants[step] = max(0, st.grants.get(step, 0) - 1)
    st.open_step = step
    return st.runs[step]


def _reset_set(g: Graph, target: str) -> Set[str]:
    return {target} | g.descendants(target)


def finish(g: Graph, st: State, step: str, outcome: str) -> None:
    """A step ends with an outcome: apply what the graph says that outcome does."""
    st.open_step = None
    if outcome in RESERVED_OUTCOMES:
        return
    if step == ENTRY:
        st.entered = True
        return
    if step == EXIT:
        st.ended = "finished" if outcome == "pass" else "exit_refused"
        return
    was_forced = bool(st.forced and st.forced.ask == step)
    if was_forced:
        st.forced = None
    st.done[step] = outcome
    st.skipped.discard(step)
    action = g.on(step, outcome)
    if action is None:
        return
    if action == "end":
        st.ended = "{}.{}".format(step, outcome)
        return
    target, max_loops, at_limit = action["goto"], action["max_loops"], action["at_limit"]
    reset = _reset_set(g, target)
    key = (step, target)
    human = was_forced   # a goto taken when Josh was sent here by a limit is his own yes
    roles_at_cap = [r for r in g.order if r in reset and g.kind(r) == "role" and st.runs.get(r, 0) > 0
                    and st.runs[r] + 1 > g.cap(r) + st.consumed.get(r, 0) + st.grants.get(r, 0)]
    if not human:
        if st.loops.get(key, 0) >= max_loops:
            st.forced = Forced(at_limit, "loop", step, outcome)
            return
        if roles_at_cap:
            # JP-194: a step at its cap may never run on this pass (the drafter runs only when the verdict says revise),
            # so the loop is taken and the cap is held until that step is the next to start (see decide()).
            st.eager = Held(Forced(at_limit, "cap", step, outcome), key, dict(st.done), frozenset(st.skipped))
            for r in roles_at_cap:
                st.cap_asks[r] = st.eager
    else:
        for r in roles_at_cap:
            st.grants[r] = st.grants.get(r, 0) + 1
            st.cap_asks.pop(r, None)
    st.loops[key] = st.loops.get(key, 0) + 1
    for sid in reset:
        st.done.pop(sid, None)
        st.skipped.discard(sid)


def replay(g: Graph, rows: List[dict]) -> State:
    """Rebuild a run's state from its step rows: [{step, attempt, outcome or None, allowed}], oldest first."""
    st = State()
    for i, row in enumerate(rows):
        step, attempt = row["step"], row["attempt"]
        if step in (ENTRY, EXIT):
            if (step == ENTRY) != (i == 0) or (step == EXIT and decide(g, st).kind != "exit"):
                raise Corrupt("the ledger has the step '{}' where the graph does not put it".format(step))
        else:
            if row.get("allowed"):   # an `allow` from Josh is not in the ledger; the flag on the row is its trace
                st.grants[step] = max(1, st.grants.get(step, 0))
            expected = decide(g, st)
            if (expected.step != step or expected.kind != "ask") and st.eager and st.eager[0].ask == step:
                # A run a walker from before JP-194 recorded: it went to the ask as soon as the loop met a capped step,
                # without taking the loop. Put the run back as that walker left it.
                held = st.eager
                st.loops[held.loop] -= 1
                if not st.loops[held.loop]:
                    del st.loops[held.loop]
                _hold(st, held)
                st.forced = held.forced
                expected = decide(g, st)
            if expected.step != step or expected.kind not in ("run", "gate", "wait", "ask"):
                raise Corrupt("the ledger has step '{}' where the graph says '{}' comes next".format(
                    step, expected.step or expected.kind))
        if attempt != st.runs.get(step, 0) + 1:
            raise Corrupt("step '{}' has attempt {} but {} runs came before".format(step, attempt, st.runs.get(step, 0)))
        begin(g, st, step, allowed=bool(row.get("allowed")))
        if row["outcome"] is not None:
            finish(g, st, step, row["outcome"])
    return st
