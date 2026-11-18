"""Move a run forward: the part of the walker that touches the ledger, the run folder, gates and the question store.

`advance` is what `next` calls. It rebuilds the run's state by replay, runs gate steps itself, parks asks, and
stops at the first thing only someone else can do: a role step for the binding to start, a question for Josh, the end
of the run, or a stop. Calling it again changes nothing until that thing has been done.
"""
from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Dict, List, Optional

from ledger import db
from lib import patient_data  # graphs/gates/lib, on sys.path through ledger._repo

from . import engine, gates, ledgerio, questions, runfolder
from .graphfile import SHORT_CODE, Graph

MAX_STEPS_PER_CALL = 200
PENDING = "pending"   # what a wait answers while it waits (graphs/CONVENTION.md, "Wait steps")


class Run:
    """One run, loaded: the graph, the ledger row, the run folder's document and the replayed state."""

    def __init__(self, conn: sqlite3.Connection, graph: Graph, run_id: str, row, doc: dict):
        self.conn, self.graph, self.run_id, self.row, self.doc = conn, graph, run_id, row, doc
        self.warnings: List[str] = []
        self.refresh()

    def refresh(self) -> None:
        self.rows = ledgerio.rows_for(self.conn, self.run_id)
        self.state = engine.replay(self.graph, self.rows)
        for step in self.doc.get("allow", []):
            self.state.grants[step] = self.state.grants.get(step, 0) + 1

    @property
    def ticket(self) -> Optional[str]:
        return self.row["ticket_key"]

    @property
    def values(self) -> Dict[str, object]:
        """Inputs, then outputs oldest step first, so the step that finished last wins a shared output name."""
        last: Dict[str, int] = {}
        for i, row in enumerate(self.rows):
            if row["outcome"] is not None:
                last[row["step"]] = i
        return runfolder.values(self.doc, sorted(last, key=last.get))

    @property
    def phi(self) -> bool:
        return bool(self.row["phi"])

    def save(self) -> None:
        runfolder.save(self.run_id, self.doc)

    def env(self, names: List[str], step: Optional[str]) -> Dict[str, str]:
        target = self.graph.stretch_status(step) if step else None
        return gates.gate_env(self.values, names, self.run_id, str(runfolder.runs_dir()), self.ticket, target)

    def cwd(self) -> Path:
        return runfolder.folder(self.run_id)


# --- Jira effects: warnings, never stops ------------------------------------------------------------------------
def _warn(run: Run, what: str, message: str) -> None:
    run.warnings.append("{}: {}".format(what, message))


def ensure_status(run: Run, step: str) -> None:
    status = run.graph.stretch_status(step)
    if not run.ticket or not status or run.doc.get("jira_status") == status:
        return
    if run.graph.kind(step) == "gate" and "move_ticket" in (run.graph.steps[step].get("effects") or []):
        return   # that step moves the ticket itself, and is told the target
    ok, message = gates.move_status(run.graph.root, run.ticket, status, run.env([], step), run.cwd())
    if ok:
        run.doc["jira_status"] = status
        run.save()
    else:
        _warn(run, "the ticket was not moved to {}".format(status), message)


def set_flag(run: Run, on: bool) -> None:
    if not run.ticket or bool(run.doc.get("flag_on")) == on:
        return
    ok, message = gates.set_flag(run.graph.root, run.ticket, on, run.env([], None))
    if ok:
        run.doc["flag_on"] = on
        run.save()
    else:
        _warn(run, "the Jira flag was not {}".format("set" if on else "cleared"), message)


def post_answer(run: Run, step: str, text: str) -> None:
    if not run.ticket:
        return
    body = "Josh's answer: " + text
    problems = patient_data.scan(body, None, run.phi, external=True)
    if problems:
        _warn(run, "the answer was not posted on the ticket", "the patient-data screen found " + ", ".join(problems))
        return
    path = run.cwd() / "outputs" / "answer-{}.txt".format(step)
    path.write_text(body, encoding="utf-8")
    ok, message = gates.post_comment(run.graph.root, run.ticket, path, run.env([], None))
    if not ok:
        _warn(run, "the answer was not posted on the ticket", message)


def _record_answer(run: Run, step: str, text: object) -> None:
    """A step output named `answer` goes to work/answers.md, where the next session that needs it reads it."""
    if isinstance(text, str) and text.strip():
        runfolder.append_answer(run.run_id, step, text, ledgerio.now())


# --- Steps -------------------------------------------------------------------------------------------------------
def _note(run: Run, text: Optional[str]) -> Optional[str]:
    if not text or run.phi or patient_data.scan(text, None, False, external=True):
        return None
    return text.strip().splitlines()[0][:200]


def _start(run: Run, step: str, kind: str, allowed: bool = False) -> int:
    g = run.graph
    attempt = engine.begin(g, run.state, step, allowed)
    role = g.steps[step].get("role") if step in g.steps else None
    agent = g.resolve_agent(step, run.values) if role else None
    row_id = ledgerio.start_step(run.conn, run.run_id, step, kind, attempt, attempt - 1, g.tier(step) if role else None,
                                 role, agent, allowed, ledgerio.now())
    run.rows.append({"id": row_id, "step": step, "attempt": attempt, "allowed": allowed, "kind": kind,
                     "outcome": None, "session_uid": None, "model": None})
    return row_id


def _end(run: Run, step_row_id: int, outcome: str, note: Optional[str] = None, model=None, session_uid=None) -> None:
    ledgerio.end_step(run.conn, step_row_id, outcome, ledgerio.now(), model, session_uid, _note(run, note))
    run.refresh()


def run_gate_step(run: Run, step: str, name: str, names: List[str], outcomes: Optional[List[str]],
                  declared: Optional[dict] = None) -> engine.State:
    g = run.graph
    row_id = _start(run, step, "gate")
    result = gates.run_gate(g.root, name, run.env(names, step), run.cwd(), outcomes)
    return _finish_gate(run, step, row_id, result, declared)


def _finish_gate(run: Run, step: str, row_id: int, result: gates.GateResult, declared: Optional[dict]) -> engine.State:
    g = run.graph
    if result.error:
        _end(run, row_id, engine.ERROR, result.error)
        run.doc["stopped"] = {"step": step, "reason": result.error}
        run.save()
        set_flag(run, True)
        return run.state
    if declared is not None:
        kept = {k: v for k, v in result.outputs.items() if k in declared}
        runfolder.save_outputs(run.doc, step, kept)
        _record_answer(run, step, kept.get("answer"))
    if step in g.steps and "move_ticket" in (g.steps[step].get("effects") or []):
        run.doc["jira_status"] = g.stretch_status(step)
    run.save()
    _end(run, row_id, result.outcome, result.summary)
    return run.state


def run_wait_step(run: Run, step: str) -> Optional[Dict[str, object]]:
    """Run a wait's script before anything is written. `pending` writes nothing and returns the `waiting` answer;
    any declared outcome (or an error) writes one row, as a gate does, and returns None so the run goes on."""
    g = run.graph
    s = g.steps[step]
    result = gates.run_gate(g.root, s["wait"], run.env(list(s.get("inputs") or []), step), run.cwd(),
                            g.outcomes(step) + [PENDING])
    if result.error is None and result.outcome == PENDING:
        now = ledgerio.now()
        before = run.doc.get("waiting") or {}
        since = before.get("since") if before.get("step") == step else now
        run.doc["waiting"] = {"step": step, "since": since, "checked": now}
        run.save()
        return {"action": "waiting", "run": run.run_id, "step": step, "gate": s["wait"],
                "summary": _note(run, result.summary), "waiting_since": since}
    row_id = _start(run, step, "gate")
    if run.doc.pop("waiting", None) is not None:
        run.save()
    _finish_gate(run, step, row_id, result, s.get("outputs") or {})
    return None


# --- Asks --------------------------------------------------------------------------------------------------------
def _ancestors_card(run: Run, step: str) -> Optional[str]:
    g = run.graph
    card = None
    for sid in g.order:
        if step in g.descendants(sid) and "card" in (run.doc.get("outputs", {}).get(sid) or {}):
            card = run.doc["outputs"][sid]["card"]
    if not isinstance(card, str) or not card:
        return None
    try:
        return Path(card).read_text(encoding="utf-8")[:4000] if runfolder.is_saved_file(card) else card[:4000]
    except OSError:
        return card[:4000]


def category_of(run: Run, step: str):
    """`<graph>/<step>` plus `;<name>=<value>` for each name in the ask's split. Second value: precedent allowed."""
    split = run.graph.steps[step]["ask"].get("split") or []
    category = "{}/{}".format(run.graph.id, step)
    usable = True
    for name in split:
        value = run.values.get(name)
        value = "_" if value is None else str(value)
        if not SHORT_CODE.match(value):
            value, usable = "_", False
        category += ";{}={}".format(name, value)
    return category[:240], usable


def _ask_text(run: Run, step: str) -> str:
    g = run.graph
    text = g.render(g.steps[step]["ask"]["question"], run.values)
    card = _ancestors_card(run, step)
    return text + ("\n\n" + card if card else "")


def _ensure_question(run: Run, step: str, attempt: int) -> str:
    qid = questions.question_id(run.run_id, step, attempt)
    questions.create(qid, run.run_id, run.ticket, str(run.cwd()), step, _ask_text(run, step),
                     list(run.graph.steps[step]["ask"]["choices"]), ledgerio.now())
    set_flag(run, True)
    return qid


def park(run: Run, step: str) -> None:
    g = run.graph
    row_id = _start(run, step, "ask")
    attempt = run.state.runs[step]
    category, usable = category_of(run, step)
    system = run.values.get("system")
    work_type = run.values.get("work_type")
    system = str(system) if system not in (None, "none") else None
    work_type = str(work_type) if work_type not in (None, "none") else None
    stage = ledgerio.category_stage(run.conn, category) if usable else 1
    suggested = precedent_id = None
    if usable:
        found = ledgerio.lookup_precedent(run.conn, row_id, run.run_id, category, "{}/{}".format(g.id, step),
                                          system, work_type, ledgerio.now())
        if found and stage >= 2:
            suggested, precedent_id = found[0]["answer"], found[0]["id"]
    ledgerio.record_ask(
        run.conn, ask_id="ask-{}-{}-{}".format(run.run_id, step, attempt), run_id=run.run_id, step_run_id=row_id,
        category=category, question_key="{}/{}".format(g.id, step), system=system, work_type=work_type,
        ticket_key=run.ticket, question=None if run.phi else _ask_text(run, step)[:500],
        choices=None if run.phi else list(g.steps[step]["ask"]["choices"]), stage=stage, suggested=suggested,
        precedent_id=precedent_id, channel="needs-you", now=ledgerio.now())
    _ensure_question(run, step, attempt)


def check_answer(run: Run, step: str) -> Optional[str]:
    """If the open ask has been answered, record it and return its outcome; otherwise None (still parked)."""
    g = run.graph
    open_row = run.rows[-1]
    attempt = open_row["attempt"]
    qid = _ensure_question(run, step, attempt)
    record = questions.read(qid)
    text = questions.answer_of(record) if record else None
    if text is None:
        return None
    choices = list(g.steps[step]["ask"]["choices"])
    free = text not in choices
    if free and "answered" not in choices:
        questions.reopen(qid)
        _warn(run, "the answer was not used", "'{}' is not one of the choices ({})".format(text[:40], ", ".join(choices)))
        return None
    outcome = "answered" if free else text
    ask = ledgerio.ask_for_step(run.conn, open_row["id"])
    suggested = ask["suggested_answer"] if ask else None
    how, rests = "answered", None
    if suggested:
        how = "confirmed-suggestion" if text == suggested else "changed-suggestion"
        rests = ask["precedent_decision_id"]
    stored = outcome if (run.phi and free) else text
    with db.transaction(run.conn):
        ledgerio.record_decision(run.conn, ask, stored, how, rests, ledgerio.now()) if ask else None
        ledgerio.end_step(run.conn, open_row["id"], outcome, ledgerio.now(), None, None, None)
    runfolder.save_outputs(run.doc, step, {"answer": text})
    run.save()
    _record_answer(run, step, text)
    questions.mark_delivered(qid, ledgerio.now())
    set_flag(run, False)
    if free:
        post_answer(run, step, text)
    run.refresh()
    return outcome


# --- The run ----------------------------------------------------------------------------------------------------
def conclude(run: Run) -> Dict[str, object]:
    """The run ended: write its end, save its files, take the flag off."""
    g = run.graph
    ended = run.state.ended
    if ledgerio.run_end(run.conn, run.run_id) is None:
        saved = runfolder.save_files(run.run_id, runfolder.files_to_save(g, run.doc, run.run_id))
        row_ids = {}
        for r in run.rows:
            row_ids[r["step"]] = r["id"]
        with db.transaction(run.conn):
            for item in saved:
                ledgerio.add_run_file(run.conn, run.run_id, row_ids.get(item["step"]), item["kind"], item["name"][:60],
                                      item["path"], item["sha256"], ledgerio.now())
            ledgerio.end_run(run.conn, run.run_id, ended, g.end_score(ended), ledgerio.now())
    set_flag(run, False)
    if run.doc.get("ended") != ended:
        run.doc["ended"] = ended  # an entry gate (ticket-creation's intake-admitted) tells open runs from ended ones
        run.save()
    return {"action": "done", "run": run.run_id, "end": ended, "score": g.end_score(ended)}


def run_action(run: Run, act: engine.Action, attempt: int) -> Dict[str, object]:
    g = run.graph
    step = act.step
    s = g.steps[step]
    values = run.values
    names = list(s.get("inputs") or [])
    role = s["role"]
    out = {
        "action": "run", "run": run.run_id, "step": step, "kind": "role", "role": role,
        "agent": g.resolve_agent(step, values), "tier": g.tier(step), "models": g.tiers[g.tier(step)],
        "brief": g.render(s.get("brief", ""), values), "inputs": {n: values.get(n) for n in names},
        "outcomes": list(s.get("outcomes") or []), "jira_status": g.stretch_status(step), "attempt": attempt,
        "allowed_by_josh": bool(act.allowed),
        "result_file": str(runfolder.result_file(run.run_id, step, attempt)),
        "role_folder": str(g.root / "roles" / role),
        "graph": g.id, "ticket": run.ticket, "access": g.header["access"][step],
        "work_dir": str(runfolder.work_dir(run.run_id)), "phi": run.phi,
    }
    if out["agent"]:
        out["agent_folder"] = str(g.root / "agents" / out["agent"])
    if attempt > 1:
        # A step that loops back (a draft after a failed check) needs what the steps after it found. The checker keeps
        # a step's declared inputs to its ancestors' outputs, so the rest comes here, named, and only on a re-run.
        out["so_far"] = {n: v for n, v in values.items() if n not in names}
    return out


def advance(run: Run) -> Dict[str, object]:
    g = run.graph
    for _ in range(MAX_STEPS_PER_CALL):
        st = run.state
        if st.ended:
            return _with_warnings(run, conclude(run))
        if run.doc.get("stopped"):
            return _with_warnings(run, {"action": "stopped", "run": run.run_id, **run.doc["stopped"]})
        if st.open_step:
            step = st.open_step
            row = run.rows[-1]
            if step in g.steps and g.kind(step) == "role":
                ensure_status(run, step)
                return _with_warnings(run, run_action(run, engine.Action("run", step, row["allowed"]), row["attempt"]))
            if step in g.steps and g.kind(step) == "ask":
                if check_answer(run, step) is None:
                    return _with_warnings(run, _parked(run, step, row["attempt"]))
                continue
            _end(run, row["id"], engine.ABANDONED, "a step that never finished (the process was cut off)")
            continue
        act = engine.decide(g, st)
        if act.kind == "stopped":
            run.doc["stopped"] = {"step": act.step, "reason": act.reason}
            run.save()
            set_flag(run, True)
            continue
        if act.kind == "exit":
            run_gate_step(run, engine.EXIT, g.header["exit_gate"], [], None)
            continue
        if act.kind == "gate":
            ensure_status(run, act.step)
            s = g.steps[act.step]
            run_gate_step(run, act.step, s["gate"], list(s.get("inputs") or []), g.outcomes(act.step),
                          s.get("outputs") or {})
            continue
        if act.kind == "wait":
            ensure_status(run, act.step)
            waiting = run_wait_step(run, act.step)
            if waiting is not None:
                return _with_warnings(run, waiting)
            continue
        if act.kind == "ask":
            ensure_status(run, act.step)
            park(run, act.step)
            return _with_warnings(run, _parked(run, act.step, run.state.runs[act.step], act.forced))
        if act.kind == "run":
            ensure_status(run, act.step)
            attempt = run.state.runs.get(act.step, 0) + 1
            _start(run, act.step, "role", act.allowed)
            if act.allowed and act.step in run.doc.get("allow", []):
                run.doc["allow"].remove(act.step)
                run.save()
            return _with_warnings(run, run_action(run, act, attempt))
    raise RuntimeError("the walker went round {} times in one call; the graph may not end".format(MAX_STEPS_PER_CALL))


def _parked(run: Run, step: str, attempt: int, forced: Optional[engine.Forced] = None) -> Dict[str, object]:
    out = {"action": "parked", "run": run.run_id, "step": step,
           "ask_id": "ask-{}-{}-{}".format(run.run_id, step, attempt),
           "question_id": questions.question_id(run.run_id, step, attempt)}
    if forced:
        out["limit"] = forced.reason
    return out


def _with_warnings(run: Run, out: Dict[str, object]) -> Dict[str, object]:
    if run.warnings:
        out["warnings"] = list(run.warnings)
    return out
