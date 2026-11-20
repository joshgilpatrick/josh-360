#!/usr/bin/env python3
"""The `console-terminal` job (JP-185): keep one Agent Manager terminal running the console, and always exit 0.

Every five minutes:

1. `~/.josh-360/state/console-off` exists: do nothing (status `off`).
2. The console's heartbeat (`state/console-heartbeat.json`, written every 30 seconds) is fresh: do nothing, with no
   Agent Manager call at all (status `running`).
3. Otherwise list Agent Manager's terminals. If the list cannot be read, do nothing (status `unknown`): a second
   console is never opened on a guess.
4. The terminal this job opened (its id is in `state/console-terminal.json`), or one named `console`, is still
   listed: send the console command to it again, at most once every ten minutes (status `restarted`, or `starting`
   while it waits for the first heartbeat).
5. None is listed: open one in group `josh-360`, record its id, send it the command (status `started`).

The console names its own terminal `console` when it starts (`--name console`). The report holds the status, the
terminal id and the heartbeat's age only. A problem is in the report, never in the exit code, because the job runner
publishes a report only when the job exits 0. Python 3.9, standard library only. No model call.
"""
from __future__ import annotations

import calendar
import json
import os
import shlex
import sys
import time
from pathlib import Path
from typing import List, Optional

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent.parent
for _p in (str(ROOT), str(ROOT / "scripts")):
    if _p not in sys.path:
        sys.path.insert(0, _p)
from laptop import common  # noqa: E402
from console_lib import am  # noqa: E402
from console_lib import events as ev  # noqa: E402

GROUP = "josh-360"
NAME = "console"
FRESH_SECONDS = 120          # four missed heartbeats
RESEND_SECONDS = 600


def _paths(home: Path) -> dict:
    state = home / "state"
    return {"off": state / "console-off", "heartbeat": state / "console-heartbeat.json",
            "record": state / "console-terminal.json"}


def heartbeat_age(path: Path, now: float) -> Optional[int]:
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
        at = ev.normalise(doc.get("at")) if isinstance(doc, dict) else None
        if at is None:
            return None
        return max(0, int(now - calendar.timegm(time.strptime(at, "%Y-%m-%dT%H:%M:%SZ"))))
    except (OSError, ValueError, OverflowError):
        return None


def command(home: Path) -> str:
    """The line typed into the terminal: the laptop copy's console, with the home only when it is not the default."""
    parts = []
    if os.environ.get("JOSH360_HOME"):
        parts.append("JOSH360_HOME={}".format(shlex.quote(str(home))))
    parts += [shlex.quote(sys.executable), shlex.quote(str(ROOT / "scripts" / "console.py")), "--heartbeat",
              "--name", NAME]
    return " ".join(parts)


def terminals(listed) -> List[dict]:
    """Agent Manager's terminal list as dicts with an `id` and a `name`; raises ValueError on a shape it cannot read."""
    rows = listed.get("terminals") if isinstance(listed, dict) else listed
    if not isinstance(rows, list):
        raise ValueError("terminal list is not a list")
    found = []
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("a terminal entry is not an object")
        ident = row.get("id") or row.get("terminal_id")
        if ident is None:
            raise ValueError("a terminal entry has no id")
        found.append({"id": str(ident), "name": str(row.get("name") or row.get("title") or "")})
    return found


def _save(lane: common.Lane, path: Path, doc: dict) -> None:
    lane.mkdir(path.parent)
    lane.write_text(path, common.dump_json(doc))


def keep_alive(home: Path, now: float) -> dict:
    paths, lane = _paths(home), common.Lane(home)
    age = heartbeat_age(paths["heartbeat"], now)
    report = {"status": "", "heartbeat_fresh": 1 if age is not None and age <= FRESH_SECONDS else 0,
              "heartbeat_age_seconds": age, "terminal": None}
    if paths["off"].exists():
        report["status"] = "off"
        return report
    record = common.read_json(paths["record"], {})
    record = record if isinstance(record, dict) else {}
    report["terminal"] = record.get("terminal_id")
    if report["heartbeat_fresh"]:
        report["status"] = "running"
        return report
    try:
        listed = terminals(am.run_json(["terminal", "list", "--json"]))
    except ValueError as err:
        report.update(status="unknown", reason="terminal list: {}".format(str(err)[:160]))
        return report
    ids = {t["id"] for t in listed}
    tid = record.get("terminal_id") if record.get("terminal_id") in ids else None
    if tid is None:
        named = [t["id"] for t in listed if t["name"] == NAME]
        tid = named[0] if named else None
    if tid is not None:
        report["terminal"] = tid
        if record.get("terminal_id") == tid and now - float(record.get("sent_at_epoch") or 0) < RESEND_SECONDS:
            report["status"] = "starting"
            return report
        status = "restarted"
    else:
        code, out, err = am.run(["create-group", GROUP])
        if code != 0 and "already exists" not in (out + err).lower():
            report.update(status="failed", reason="create-group: {}".format((err or out).strip()[:160]))
            return report
        try:
            created = am.run_json(["terminal", "create", "--group", GROUP, "--directory", str(ROOT), "--nest=false",
                                   "--json"])
            tid = str(created.get("id") or created.get("terminal_id") or "") if isinstance(created, dict) else ""
        except ValueError as err:
            report.update(status="failed", reason="terminal create: {}".format(str(err)[:160]))
            return report
        if not tid:
            report.update(status="failed", reason="terminal create gave no id")
            return report
        report["terminal"] = tid
        _save(lane, paths["record"], {"terminal_id": tid, "created_at": ev.iso_from_epoch(now)})
        status = "started"
    code, out, err = am.run(["terminal", "send", tid, "--command", command(home)])
    if code != 0:
        report.update(status="failed", reason="terminal send: {}".format((err or out).strip()[:160]))
        return report
    _save(lane, paths["record"], {"terminal_id": tid, "created_at": record.get("created_at") if record.get(
        "terminal_id") == tid else ev.iso_from_epoch(now), "sent_at": ev.iso_from_epoch(now), "sent_at_epoch": now})
    report["status"] = status
    return report


def main(out=None, now=time.time) -> int:
    out = out or sys.stdout
    try:
        report = keep_alive(common.home(), now())
    except Exception as err:  # noqa: BLE001  (the report is the place for a problem; see the docstring)
        report = {"status": "error", "error": type(err).__name__, "heartbeat_fresh": 0}
    out.write(json.dumps(report, sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
