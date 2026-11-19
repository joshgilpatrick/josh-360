"""Telling the sprint lead or the epic lead what a run did (JP-175). Python 3.9, standard library only.

The leads stay the coordinators (Josh, 19 November 2026): the runner tells them, by script and with no model call,
when a run stops, parks on a question for Josh, files a follow-up, drops one, or finishes. Who the lead is comes from
the sprint skill's own state files (`~/.claude/sprint-state/<slug>/`, read only; `SPRINT_STATE_ROOT` moves it):

- the **epic lead** is the project manager session of the ticket's epic (`tickets/<EPIC>.json` with role `pm`) in
  any sprint, when Agent Manager shows it running;
- otherwise the **sprint lead**: the lead of the sprint that holds the ticket, else the one that holds its epic, else
  the only sprint whose lead is running.

A filed follow-up goes to a sprint lead through `sprint.py handoff`, and to an epic lead by `agent-manager send` with
the same words. Every message is kept in `<run>/lead-messages.json`, sent or not: one with no running lead is kept
unsent, a later pass of the same run sends it once a lead runs, and `runner.py messages` lists every unsent one.
The wording is fixed and carries keys, step names and outcomes only, never a step's own words.
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Callable, Dict, List, Optional

from . import paths  # noqa: F401  (puts the repository root and graphs/tools on sys.path)
from lib import follow_ups  # noqa: E402
from walker_lib import runfolder  # noqa: E402

FILE = "lead-messages.json"


# -- the words -----------------------------------------------------------------------------------------------------

def text_for(event: str, run: dict, extra: Optional[dict] = None) -> str:
    extra = extra or {}
    who, graph, run_id = run.get("ticket") or run_id_of(run), run.get("graph") or "graph", run_id_of(run)
    if event == "stopped":
        return "[josh-360] {}: the {} run {} stopped at step {}. Read why with runner.py report --run {}.".format(
            who, graph, run_id, extra.get("step"), run_id)
    if event == "parked":
        return "[josh-360] {}: the {} run {} is waiting for Josh at {} (Needs you).".format(
            who, graph, run_id, extra.get("step"))
    if event == "filed":
        tail = "; it blocks {}, whose run waits on it".format(who) if extra.get("blocks") else \
            "; it does not block {}".format(who)
        return "[josh-360] {}: follow-up {} filed from step {}{}. Route it (lead.md, Epics).".format(
            who, extra.get("key"), extra.get("step"), tail)
    if event == "dropped":
        return "[josh-360] {}: a follow-up from step {} was dropped at ticket creation; nothing was filed.".format(
            who, extra.get("step"))
    if event == "done":
        return "[josh-360] {}: the {} run {} finished ({}).".format(who, graph, run_id, extra.get("end") or "ended")
    raise ValueError("no wording for the event '{}'".format(event))


def handoff_note(run: dict, extra: dict) -> str:
    """The note `sprint.py handoff` puts after "[sprint] new ticket <KEY>: "."""
    note = "graph follow-up from {} (step {})".format(run.get("ticket") or run_id_of(run), extra.get("step"))
    return note + (", blocks it" if extra.get("blocks") else "")


def run_id_of(run: dict) -> str:
    return str(run.get("run") or run.get("run_id") or "run")


# -- who the lead is -----------------------------------------------------------------------------------------------

def state_root() -> Path:
    return Path(os.path.expanduser(os.environ.get("SPRINT_STATE_ROOT") or "~/.claude/sprint-state"))


def _read(path: Path) -> Optional[dict]:
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
        return doc if isinstance(doc, dict) else None
    except (OSError, ValueError):
        return None


def _sprints() -> List[dict]:
    root = state_root()
    try:
        folders = sorted(p for p in root.iterdir() if p.is_dir())
    except OSError:
        return []
    found = []
    for folder in folders:
        doc = _read(folder / "sprint.json")
        if doc and doc.get("lead_session_id"):
            found.append({"slug": doc.get("slug") or folder.name, "lead": doc["lead_session_id"], "folder": folder})
    return found


def _ticket_file(sprint: dict, key: Optional[str]) -> Optional[dict]:
    if not key or "/" in key or key.startswith("."):
        return None
    return _read(sprint["folder"] / "tickets" / "{}.json".format(key))


def find_lead(ticket: Optional[str], epic: Optional[str], running: Callable[[str], bool]) -> Optional[dict]:
    """{"kind": "epic"|"sprint", "session", "sprint"} for the lead to tell, or None when no lead is running."""
    sprints = _sprints()
    if epic is None:
        for sprint in sprints:                      # the sprint's own file names the ticket's epic, when it has one
            epic = (_ticket_file(sprint, ticket) or {}).get("epic") or epic
    if epic:
        for sprint in sprints:
            pm = _ticket_file(sprint, epic) or {}
            if pm.get("role") == "pm" and pm.get("worker_session_id") and running(pm["worker_session_id"]):
                return {"kind": "epic", "session": pm["worker_session_id"], "sprint": sprint["slug"]}
    for key in (ticket, epic):
        for sprint in sprints:
            if _ticket_file(sprint, key) is not None and running(sprint["lead"]):
                return {"kind": "sprint", "session": sprint["lead"], "sprint": sprint["slug"]}
    live = [s for s in sprints if running(s["lead"])]
    if len(live) == 1:
        return {"kind": "sprint", "session": live[0]["lead"], "sprint": live[0]["slug"]}
    return None


# -- the kept messages ---------------------------------------------------------------------------------------------

def _path(run_id: str) -> Path:
    return runfolder.folder(run_id) / FILE


def load(run_id: str) -> dict:
    return _read(_path(run_id)) or {"messages": []}


def _save(run_id: str, doc: dict) -> None:
    target = _path(run_id)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(target.name + ".tmp")
    tmp.write_text(json.dumps(doc, indent=1, sort_keys=True), encoding="utf-8")
    os.replace(str(tmp), str(target))


class Teller:
    """Holds what it needs from outside: the binding (running, send, handoff) and the epic lookup."""

    def __init__(self, binding, epic_of: Callable[[str], Optional[str]], now: Callable[[], float] = time.time):
        self.binding, self.epic_of, self.now = binding, epic_of, now

    def _epic(self, run_id: str, run: dict, doc: dict) -> Optional[str]:
        if "epic" in doc:
            return doc["epic"]
        ticket = run.get("ticket")
        epic = self.epic_of(ticket) if ticket else None
        if epic is not None:
            doc["epic"] = epic or None                   # "" means "has none": kept, so Jira is read once
        return epic or None

    def tell(self, run_id: str, event: str, key: str, extra: Optional[dict] = None, repeat: bool = False) -> Optional[dict]:
        """Record one message for the event, once (a `repeat` event, a stop, may come again after a retry), and try to
        send it. Returns the message, or None when it was already recorded. A run with no ticket tells nobody."""
        try:
            run = dict(runfolder.load(run_id), run=run_id)
        except (FileNotFoundError, ValueError):
            return None
        if not run.get("ticket"):
            return None
        doc = load(run_id)
        messages = doc.setdefault("messages", [])
        if repeat:
            key = "{}#{}".format(key, 1 + sum(1 for m in messages if str(m.get("key", "")).split("#")[0] == key))
        elif any(m.get("key") == key for m in messages):
            return None
        extra = dict(extra or {})
        message = {"key": key, "event": event, "text": text_for(event, run, extra), "at": self.now(), "sent": False,
                   "to": None, "how": None, "kept": None, "extra": extra}
        messages.append(message)
        self._deliver(run_id, run, doc, message)
        _save(run_id, doc)
        return message

    def flush(self, run_id: str) -> int:
        """Try every unsent message of the run again; returns how many went."""
        doc = load(run_id)
        waiting = [m for m in doc.get("messages") or [] if not m.get("sent")]
        if not waiting:
            return 0
        try:
            run = dict(runfolder.load(run_id), run=run_id)
        except (FileNotFoundError, ValueError):
            return 0
        sent = sum(1 for m in waiting if self._deliver(run_id, run, doc, m))
        _save(run_id, doc)
        return sent

    def _deliver(self, run_id: str, run: dict, doc: dict, message: dict) -> bool:
        lead = find_lead(run.get("ticket"), self._epic(run_id, run, doc), self.binding.running)
        if lead is None:
            message["kept"] = "no running lead"
            return False
        extra = message.get("extra") or {}
        if message["event"] == "filed" and lead["kind"] == "sprint":
            ok, how = self.binding.handoff(lead["sprint"], extra.get("key"), handoff_note(run, extra)), "sprint.py handoff"
        else:
            ok, how = self.binding.send(lead["session"], message["text"]), "agent-manager send"
        if not ok:
            message["kept"] = "{} to the {} lead failed".format(how, lead["kind"])
            return False
        message.update(sent=True, to={"kind": lead["kind"], "session": lead["session"], "sprint": lead["sprint"]},
                       how=how, kept=None, sent_at=self.now())
        return True

    # -- follow-ups ------------------------------------------------------------------------------------------------

    def follow_up_events(self, run_id: str) -> None:
        """Tell the lead about each follow-up of the run that was filed or dropped since the last look."""
        for item in follow_ups.load_all(run_id):
            ref = follow_ups.ref(run_id, item["id"])
            if item.get("state") == "submitted" and item.get("intake_run"):
                try:
                    if follow_ups.settle_dropped(ref, runfolder.load(str(item["intake_run"]))):
                        item = follow_ups.load(ref) or item
                except (FileNotFoundError, ValueError):
                    pass
            if item.get("state") in ("filed", "resolved") and item.get("key"):
                self.tell(run_id, "filed", "follow-up:{}:filed".format(item["id"]),
                          {"key": item["key"], "step": item.get("step"), "blocks": bool(item.get("blocks"))})
            elif item.get("state") == "dropped":
                self.tell(run_id, "dropped", "follow-up:{}:dropped".format(item["id"]), {"step": item.get("step")})


def origin_run(run_id: str) -> Optional[str]:
    """For a ticket-creation run that is filing a follow-up, the run the follow-up came from."""
    try:
        doc = runfolder.load(run_id)
    except (FileNotFoundError, ValueError):
        return None
    inputs = doc.get("inputs") or {}
    found = follow_ups.parse_ref(str(inputs.get("source_ref") or "")) if inputs.get("source") == "session" else None
    return found[0] if found else None


def unsent(runs_dir: Optional[Path] = None) -> List[Dict[str, object]]:
    """Every kept, unsent message in every run folder, oldest first: what a new lead reads first."""
    base = runs_dir or runfolder.runs_dir()
    rows = []
    try:
        folders = [p for p in base.iterdir() if p.is_dir()]
    except OSError:
        return []
    for folder in folders:
        for m in (_read(folder / FILE) or {}).get("messages") or []:
            if not m.get("sent"):
                rows.append({"run": folder.name, "at": m.get("at"), "event": m.get("event"), "text": m.get("text"),
                             "kept": m.get("kept")})
    return sorted(rows, key=lambda r: (r["at"] or 0, r["run"]))
