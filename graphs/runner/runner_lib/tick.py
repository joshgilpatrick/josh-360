"""One pass of the runner (JP-117): watch Jira, start the runs it says to, and launch an `advance` for every run that
could move. Python 3.9, standard library only.

The tick never waits for a step: `advance` runs in a child process of its own (a gate may take ten minutes and a pass
has five), so a pass that launches it returns at once and the next pass finds the run's lock held and leaves it alone.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Callable, List, Optional

from . import ledgerview, locks, notify, paths, status, walk, watch
from ledger import db  # noqa: E402
from walker_lib import questions, runfolder  # noqa: E402

RUNNER = status.RUNNER
STALE_NOTICE = "The graph runner loop has stopped. Start it again in an Agent Manager terminal."
_children: List[subprocess.Popen] = []


class LoopRefused(Exception):
    """`loop` will not start. The message says why."""


def _starts_path() -> Path:
    return Path(os.environ.get("JOSH360_RUNNER_STARTS") or str(watch.RULES))


def _read_json(path: Path) -> Optional[dict]:
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
        return doc if isinstance(doc, dict) else None
    except (OSError, ValueError):
        return None


def needs_advance(conn, run: dict) -> bool:
    """Whether a pass should launch `advance` for the run. Reads files and the ledger only: never the walker or Agent Manager."""
    run_id = run["run"]
    try:
        if locks.is_held(runfolder.folder(run_id) / "advance.lock"):
            return False
        doc = runfolder.load(run_id)
    except (FileNotFoundError, ValueError):
        return False
    step = ledgerview.open_step(conn, run_id)
    stopped = doc.get("stopped")
    if stopped:
        noted = (_read_json(runfolder.folder(run_id) / "runner.json") or {}).get("noted") or []
        return "stopped:{}".format(stopped.get("step")) not in noted
    if step is not None and step["kind"] == "ask":
        record = questions.read(questions.question_id(run_id, step["step"], step["attempt"]))
        if record is not None and record.get("state") == "open":
            return False                                    # waiting for Josh; his answer makes it launchable
    return True


def detached(run_id: str) -> None:
    """Start `runner.py advance --run <id>` on its own, in its own session, and do not wait for it."""
    log = paths.run_log(run_id)
    log.parent.mkdir(parents=True, exist_ok=True)
    _children[:] = [c for c in _children if c.poll() is None]            # reap the ones that finished
    with open(str(log), "ab") as handle:
        child = subprocess.Popen([sys.executable, str(paths.HERE / "runner.py"), "advance", "--run", run_id],
                                 stdin=subprocess.DEVNULL, stdout=handle, stderr=handle, start_new_session=True,
                                 close_fds=True)
    _children.append(child)


def tick(now: Callable[[], float] = time.time, launcher: Callable[[str], object] = detached, jira="default",
         root: Optional[Path] = None) -> dict:
    """One pass. Returns the report (also written to `report.json`), or {"status": "busy"} when another pass is running."""
    try:
        with locks.held(paths.state_dir() / "tick.lock"):
            return _tick(now, launcher, jira, root)
    except locks.Held:
        return {"status": "busy"}


def _tick(now, launcher, jira, root) -> dict:
    conn = db.connect(db.ledger_path())
    try:
        watched: dict = {}
        if not paths.is_off():
            client = watch.jira_client(dict(os.environ)) if jira == "default" else jira
            try:
                watched = watch.watch(conn, client, watch.load_rules(_starts_path()), root=root)
            except (ValueError, OSError) as err:
                paths.log("tick: the start rules cannot be read: {}".format(str(err)[:200]))
                watched = {"error": "start rules unreadable"}
        for run in ledgerview.open_runs(conn, RUNNER):
            if needs_advance(conn, run):
                try:
                    launcher(run["run"])
                except Exception as err:  # noqa: BLE001  (one run that cannot be launched must not stop the others)
                    paths.log("tick: could not launch advance for {}: {}".format(run["run"], type(err).__name__))
        report = status.snapshot(conn, now(), root)
    finally:
        conn.close()
    report["watch"] = watched
    target = paths.state_dir() / "report.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(target.name + ".tmp")
    tmp.write_text(json.dumps(report, indent=1, sort_keys=True), encoding="utf-8")
    os.replace(str(tmp), str(target))
    return report


# -- the terminal host ---------------------------------------------------------------------------------------------


def _heartbeat() -> Path:
    return paths.state_dir() / "heartbeat.json"


def loop(sleep: Callable[[float], object] = time.sleep, turns: Optional[int] = None) -> None:
    """The terminal host's loop: tick, write the heartbeat, sleep. Refuses under the job host or a second loop."""
    cfg = paths.settings()
    if cfg["host"] != "terminal":
        raise LoopRefused("host is '{}'; the loop is for host 'terminal'".format(cfg["host"]))
    try:
        with locks.held(paths.state_dir() / "loop.lock"):
            done = 0
            while turns is None or done < turns:
                try:
                    tick()
                except Exception as err:  # noqa: BLE001  (the loop goes on)
                    paths.log("loop: a turn failed: {}".format(type(err).__name__))
                _heartbeat().parent.mkdir(parents=True, exist_ok=True)
                _heartbeat().write_text(json.dumps({"at": time.time(), "pid": os.getpid()}), encoding="utf-8")
                sleep(cfg["tick_seconds"])
                done += 1
    except locks.Held:
        raise LoopRefused("another loop is running")


def heartbeat_report(now: float) -> dict:
    """The loop's last report plus whether its heartbeat has gone stale; sends one notice per stale spell."""
    report = _read_json(paths.state_dir() / "report.json") or {"status": "no-report"}
    beat = _read_json(_heartbeat())
    stale_after = float(paths.settings()["heartbeat_stale_seconds"])
    try:
        stale = beat is None or now - float(beat["at"]) > stale_after
    except (KeyError, TypeError, ValueError):
        stale = True
    flag = paths.state_dir() / "loop-stale-notified"
    if stale and not flag.exists():
        notify.notify(notify.TITLE, STALE_NOTICE)
        flag.parent.mkdir(parents=True, exist_ok=True)
        flag.write_text("")
    elif not stale and flag.exists():
        flag.unlink()
    report["loop"] = {"stale": stale}
    return report
