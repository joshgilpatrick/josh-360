"""Advancing one run (JP-117): ask the walker for the next step and do what it says, until it needs nothing more now.

Python 3.9, standard library only. The walker alone decides what comes next (this module holds no graph logic); this
module only starts a session for a role step, watches it, and hands its result back. Everything that must survive a
crash is a file: the session file `<run>/sessions/<step>-<attempt>.json` is written *before* a session is started and
read first on every pass, so a run is never given two sessions for one attempt.
"""
from __future__ import annotations

import importlib.util
import json
import os
import secrets
import time
from pathlib import Path
from typing import Callable, Optional

from . import ledgerview, locks, notify, paths, sessionfile, walk
from .hooklib import entry as session_entry, marker as step_marker
from .status import RUNNER
from ledger import db  # noqa: E402
from walker_lib import runfolder  # noqa: E402

SPAWN_LOCK_WAIT = 30.0


def load_binding(runner: str):
    """Import `graphs/bindings/<runner>/binding.py` by path. ValueError when the runner has no binding."""
    if not runner or "/" in runner or runner.startswith("."):
        raise ValueError("not a runner name: {!r}".format(runner))
    path = paths.ROOT / "graphs" / "bindings" / runner / "binding.py"
    if not path.is_file():
        raise ValueError("there is no binding for runner '{}' (looked for {})".format(runner, path))
    spec = importlib.util.spec_from_file_location("josh360_binding_" + runner.replace("-", "_"), str(path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)                                    # type: ignore[union-attr]
    return module


def advance(run_id: str, now: Callable[[], float] = time.time, root: Optional[Path] = None) -> dict:
    """One pass over the run. Returns {"run", "state"}; the state is one word (see `_loop`)."""
    lock = runfolder.folder(run_id) / "advance.lock"
    try:
        with locks.held(lock):
            return {"run": run_id, "state": _loop(run_id, now, root)}
    except locks.Held:
        return {"run": run_id, "state": "locked"}


def _open_role(run_id: str) -> bool:
    conn = db.connect(db.ledger_path())
    try:
        step = ledgerview.open_step(conn, run_id)
    finally:
        conn.close()
    return step is not None and step["kind"] == "role"


def _open_run_ids() -> list:
    conn = db.connect(db.ledger_path())
    try:
        return [r["run"] for r in ledgerview.open_runs(conn, RUNNER)]
    finally:
        conn.close()


def _loop(run_id: str, now: Callable[[], float], root: Optional[Path]) -> str:
    cfg = paths.settings()
    binding = load_binding(RUNNER)
    if not runfolder.load(run_id).get("stopped"):
        notify.forget_stops(run_id)
    began = now()
    while True:
        if now() - began >= float(cfg["advance_limit_seconds"]):
            paths.log("advance {}: stopped for the time limit".format(run_id))
            return "working"
        off = paths.is_off()
        if off and not _open_role(run_id):                 # nothing may start, and `next` could run a gate
            return "off"
        answer = walk.call("next", "--run", run_id, root=root)
        action = answer.get("action")
        if action in ("parked", "waiting"):
            return action
        if action == "stopped":
            notify.note_once(run_id, "stopped:" + str(answer.get("step")))
            paths.log("advance {}: stopped at {}: {}".format(run_id, answer.get("step"), str(answer.get("reason"))[:200]))
            return "stopped"
        if action == "done":
            notify.note_once(run_id, "done")
            return "done"
        if action != "run":
            paths.log("advance {}: the walker said '{}', which this runner does not handle".format(run_id, action))
            return "working"
        outcome = _step(run_id, answer, cfg, binding, now, root, off)
        if outcome is not None:
            return outcome


# -- one role step -------------------------------------------------------------------------------------------------


def _step(run_id: str, a: dict, cfg: dict, binding, now: Callable[[], float], root: Optional[Path], off: bool):
    """Handle the open role step. Returns the word to return, or None to go back and ask the walker again."""
    step, attempt = a["step"], a["attempt"]
    try:
        doc = sessionfile.read(run_id, step, attempt)
    except sessionfile.Unreadable as err:
        paths.log("advance {}: session file unreadable: {}".format(run_id, err))
        return "working"                                  # unknown is not empty: never start a second session
    if doc is None:
        if off:
            return "off"
        if not paths.rails_loaded():
            return "no-rails"
        return _spawn(run_id, a, None, cfg, binding, now)
    state = doc.get("state")
    if state == "spawn_failed":
        if int(doc.get("spawn_failures") or 0) >= int(cfg["spawn_tries"]):
            return _abandon(run_id, doc, "spawn-refused", now, root, off)
        if off:
            return "off"
        if not paths.rails_loaded():
            return "no-rails"
        return _spawn(run_id, a, doc, cfg, binding, now)
    if state == "spawning":
        try:
            link = sessionfile.read_link(run_id, step, attempt)
        except sessionfile.Unreadable:
            return "working"
        if link:
            doc.update(state="started", started_at=doc.get("intent_at"), handle={"am_session": link.get("am_session")})
            sessionfile.write(run_id, step, attempt, doc)
            state = "started"
        elif now() - float(doc.get("intent_at") or 0) >= float(cfg["link_timeout_seconds"]):
            return _abandon(run_id, doc, "never-started", now, root, off)
        else:
            return "working"
    if state == "started":
        return _started(run_id, a, doc, cfg, binding, now, root, off)
    paths.log("advance {}: step {} attempt {} is {} but the walker still has it open".format(run_id, step, attempt, state))
    return "working"


def _spawn(run_id: str, a: dict, doc: Optional[dict], cfg: dict, binding, now: Callable[[], float]) -> str:
    step, attempt = a["step"], a["attempt"]
    if not _spawn_slot(run_id, a, doc, cfg, now):
        return "limit" if _limit_reached(run_id, cfg) else "locked"
    doc = sessionfile.read(run_id, step, attempt) or {}
    try:
        from ledger import comments
        taken = comments.take_run(run_id)
    except ValueError:
        taken = ""
    comments_text = doc.get("comments") or taken
    doc["comments"] = comments_text
    sessionfile.write(run_id, step, attempt, doc)
    try:
        handle = binding.start(a, step_marker(run_id, step, attempt, doc["key"]), comments_text)
    except binding.SpawnRefused as err:
        doc.update(state="spawn_failed", spawn_failures=int(doc.get("spawn_failures") or 0) + 1, reason=str(err))
        sessionfile.write(run_id, step, attempt, doc)
        paths.log("advance {}: spawn of {} refused: {}".format(run_id, step, err))
        return "spawn-failed"
    doc.update(state="started", started_at=now(), handle=handle)
    sessionfile.write(run_id, step, attempt, doc)
    paths.log("advance {}: started {} attempt {}".format(run_id, step, attempt))
    return "spawned"


def _limit_reached(run_id: str, cfg: dict) -> bool:
    return len(sessionfile.live(_open_run_ids())) >= int(cfg["session_limit"])


def _spawn_slot(run_id: str, a: dict, doc: Optional[dict], cfg: dict, now: Callable[[], float]) -> bool:
    """Under the spawn lock: True once this attempt's session file says `spawning` (it then counts against the limit)."""
    deadline = time.time() + SPAWN_LOCK_WAIT
    while True:
        try:
            with locks.held(paths.state_dir() / "spawn.lock"):
                if _limit_reached(run_id, cfg):
                    return False
                base = doc or {
                    "run": run_id, "step": a["step"], "attempt": a["attempt"], "graph": a["graph"], "ticket": a["ticket"],
                    "access": a["access"], "tier": a["tier"], "outcomes": a["outcomes"], "result_file": a["result_file"],
                    "work_dir": a["work_dir"], "key": secrets.token_hex(8), "started_at": None, "handle": None,
                    "comments": "", "resting_since": None, "spawn_failures": 0, "ended_at": None, "reason": None,
                    "closed": None}
                base.update(state="spawning", intent_at=now())
                sessionfile.write(run_id, a["step"], a["attempt"], base)
                return True
        except locks.Held:
            if time.time() >= deadline:
                return False
            time.sleep(0.2)


def _started(run_id: str, a: dict, doc: dict, cfg: dict, binding, now: Callable[[], float], root: Optional[Path],
             off: bool):
    step, attempt = a["step"], a["attempt"]
    result = Path(doc["result_file"])
    try:
        link = sessionfile.read_link(run_id, step, attempt)
    except sessionfile.Unreadable:
        return "working"
    if result.exists():
        if not _parses(result) and now() - result.stat().st_mtime < float(cfg["result_settle_seconds"]):
            return "working"                              # it may still be being written
        argv = ["record", "--run", run_id, "--step", step, "--result-file", str(result), "--model",
                str((doc.get("handle") or {}).get("model") or ""), "--tool", "claude-code"]
        if link and link.get("session_id"):
            argv += ["--session", link["session_id"]]
        try:
            walk.call(*[x for x in argv if x != ""], root=root)
        except walk.WalkerRefused as err:
            paths.log("advance {}: result of {} refused: {}".format(run_id, step, str(err)[:200]))
            return _abandon(run_id, doc, "bad-result", now, root, off)
        doc.update(state="recorded", ended_at=now())
        if cfg["archive_finished_sessions"]:
            doc["closed"] = binding.close(doc.get("handle") or {})
        sessionfile.write(run_id, step, attempt, doc)
        paths.log("advance {}: recorded {} attempt {}".format(run_id, step, attempt))
        return "off" if off else None
    began = float(doc.get("started_at") or doc.get("intent_at") or 0)
    if not link and now() - began >= float(cfg["link_timeout_seconds"]):
        return _abandon(run_id, doc, "never-started", now, root, off)
    if now() - began >= float(cfg["time_cap_seconds"]) + float(cfg["time_cap_grace_seconds"]):
        return _abandon(run_id, doc, "time-cap", now, root, off)
    seen = binding.state(doc.get("handle") or {})
    if seen == "gone":
        return _abandon(run_id, doc, "session-gone", now, root, off)
    if seen == "working":
        if doc.get("resting_since") is not None:
            doc["resting_since"] = None
            sessionfile.write(run_id, step, attempt, doc)
        return "working"
    if seen == "resting":
        if doc.get("resting_since") is None:
            doc["resting_since"] = now()
            sessionfile.write(run_id, step, attempt, doc)
        clock = float(doc["resting_since"])
        if link and link.get("session_id"):
            try:
                nudged = (session_entry(link["session_id"]) or {}).get("nudged_at")
            except sessionfile.Unreadable:
                nudged = None
            if nudged is not None:
                clock = max(clock, float(nudged))
        if now() - clock >= float(cfg["rest_timeout_seconds"]):
            return _abandon(run_id, doc, "rested-without-result", now, root, off)
    return "working"


def _parses(path: Path) -> bool:
    try:
        json.loads(path.read_text(encoding="utf-8"))
        return True
    except (OSError, ValueError):
        return False


def _abandon(run_id: str, doc: dict, reason: str, now: Callable[[], float], root: Optional[Path], off: bool):
    """End this attempt in the walker, say why in the session file and the log, and (unless off) ask the walker again.
    The session is never closed: an abandoned session stays visible in Agent Manager."""
    walk.call("abandon", "--run", run_id, root=root)
    doc.update(state="abandoned", reason=reason, ended_at=now())
    sessionfile.write(run_id, doc["step"], doc["attempt"], doc)
    paths.log("advance {}: abandoned {} attempt {}: {}".format(run_id, doc["step"], doc["attempt"], reason))
    return "off" if off else None
