"""A macOS notification, and a note per run of what has already been told (JP-117). Python 3.9, standard library only."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import List

from . import paths  # noqa: F401  (puts the repository root and graphs/tools on sys.path)
from walker_lib import runfolder  # noqa: E402

TITLE = "Josh 360 runner"


def _escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def notify(title: str, body: str) -> bool:
    """Show a notification. False (and no process) off macOS or when JOSH360_NO_NOTIFY is set; any failure is False."""
    if os.environ.get("JOSH360_NO_NOTIFY") or sys.platform != "darwin":
        return False
    try:
        script = 'display notification "{}" with title "{}"'.format(_escape(body), _escape(title))
        done = subprocess.run(["/usr/bin/osascript", "-e", script], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                              timeout=15)
        return done.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def _file(run_id: str) -> Path:
    return runfolder.folder(run_id) / "runner.json"


def _read(run_id: str) -> dict:
    try:
        doc = json.loads(_file(run_id).read_text(encoding="utf-8"))
        return doc if isinstance(doc, dict) else {}
    except (OSError, ValueError):
        return {}


def _write(run_id: str, doc: dict) -> None:
    target = _file(run_id)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(target.name + ".tmp")
    tmp.write_text(json.dumps(doc, sort_keys=True), encoding="utf-8")
    os.replace(str(tmp), str(target))


def note_once(run_id: str, what: str) -> bool:
    """True the first time `what` is noted for the run (and the person is told); False after that."""
    doc = _read(run_id)
    noted: List[str] = list(doc.get("noted") or [])
    if what in noted:
        return False
    noted.append(what)
    doc["noted"] = noted
    _write(run_id, doc)
    name, graph = run_id, "graph"
    try:
        run = runfolder.load(run_id)
        name, graph = run.get("ticket") or run_id, run.get("graph") or graph
    except FileNotFoundError:
        pass
    if what.startswith("stopped:"):
        notify(TITLE, "{}: the {} run stopped at {}.".format(name, graph, what[len("stopped:"):]))
    elif what == "done":
        notify(TITLE, "{}: the {} run ended.".format(name, graph))
    return True


def forget_stops(run_id: str) -> None:
    """Drop every `stopped:*` note, so a run that stops again after a retry is told about again."""
    doc = _read(run_id)
    noted = [n for n in doc.get("noted") or [] if not str(n).startswith("stopped:")]
    if noted != list(doc.get("noted") or []):
        doc["noted"] = noted
        _write(run_id, doc)
