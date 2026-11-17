#!/usr/bin/env python3
"""JP-117: find out what the job runner can do with Agent Manager, before the runner is designed around it.

The graph runner (JP-117) has to start Agent Manager sessions from a laptop job. Two facts decide its shape, and
neither can be checked from the cloud:

1. Can `agent-manager spawn` start a session from a launchd job, outside any Agent Manager pane? The
   launch-background-session skill says `sessions` refuses there; the agent-manager-cli skill says `--tool` is
   needed when the caller is a plain terminal. Only a real spawn settles it.
2. Does a child process started in its own session (setsid) outlive the job pass? launchd kills what is left in a
   job's process group when the job exits, and the runner needs a long gate (verify-build) to outlive a pass.

This job runs every 10 minutes and prints one JSON report that the job runner publishes as
reports/agent-manager-probe.json on laptop-status. What it does, once each, recorded in its state file:

- reads `agent-manager` and `claude` versions and the help text of the commands the runner would use;
- runs `agent-manager sessions --json` and `terminal list --json` and keeps only the exit code, the first line of
  any error and, on success, whether rows came back and their field names (never a session name or value);
- reads the `sessions` table's columns and the status values in use from Agent Manager's database, read-only;
- starts one throwaway session, named "JP-117 probe - safe to archive", asking it to reply OK and stop
  (`--model` is not given, so it uses Josh's saved default), and on later passes reads that session's status;
- starts a detached `sleep` that writes a marker file after 90 seconds, and on the next pass reports whether it
  survived.

It changes nothing else, writes only under JOSH360_HOME, and holds no patient data: help text, exit codes, field
names and counts. It always exits 0, because the job runner publishes a report only for a job that exits 0.
The runner design's build removes this job once the answers are in (docs/decisions/JP-117.md).
"""
from __future__ import annotations

import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
from pathlib import Path
from typing import Dict, List, Optional
from urllib.parse import quote

sys.dont_write_bytecode = True

PROBE_NAME = "JP-117 probe - safe to archive"
PROBE_PROMPT = ("This is a one-time test from the Josh 360 runner design (JP-117). Reply with the single word OK "
                "and stop. Do not run any tool. This session can be archived.")
HELP_COMMANDS = [[], ["spawn"], ["sessions"], ["kill"], ["archive"], ["wait"], ["send"], ["read"], ["terminal"]]
HELP_LIMIT = 4000
ERR_LIMIT = 300
MARKER_DELAY = 90
CALL_TIMEOUT = 60
SPAWN_TRIES = 3
SEARCH = ["~/.local/bin", "~/bin", "~/.cargo/bin", "/opt/homebrew/bin", "/usr/local/bin"]


def home() -> Path:
    raw = os.environ.get("JOSH360_HOME") or os.path.join(os.path.expanduser("~"), ".josh-360")
    return Path(raw).absolute()


def probe_dir() -> Path:
    return home() / "state" / "agent-manager-probe"


def find_bin(name: str, override: str) -> Optional[str]:
    if os.environ.get(override):
        return os.environ[override]
    found = shutil.which(name)
    if found:
        return found
    for folder in SEARCH:
        candidate = Path(os.path.expanduser(folder)) / name
        if candidate.is_file() and os.access(str(candidate), os.X_OK):
            return str(candidate)
    return None


def first_line(text: str) -> str:
    for line in (text or "").splitlines():
        if line.strip():
            return line.strip()[:ERR_LIMIT]
    return ""


def call(argv: List[str], timeout: int = CALL_TIMEOUT) -> Dict[str, object]:
    try:
        r = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL,
                           universal_newlines=True, timeout=timeout)
        return {"code": r.returncode, "out": r.stdout, "err": r.stderr}
    except subprocess.TimeoutExpired:
        return {"code": 124, "out": "", "err": "timed out after {}s".format(timeout)}
    except OSError as e:
        return {"code": 127, "out": "", "err": "{}: {}".format(type(e).__name__, e)}


def shape(text: str) -> Dict[str, object]:
    """Row count and field names of a JSON answer, never its values."""
    try:
        data = json.loads(text)
    except ValueError:
        return {"json": False}
    rows = data if isinstance(data, list) else data.get("sessions") if isinstance(data, dict) else None
    if isinstance(rows, list):
        first = rows[0] if rows and isinstance(rows[0], dict) else {}
        return {"json": True, "any_rows": bool(rows), "fields": sorted(first)}
    return {"json": True, "fields": sorted(data) if isinstance(data, dict) else []}


def read_cli(am: str) -> Dict[str, object]:
    out: Dict[str, object] = {"version": first_line(str(call([am, "--version"])["out"]))}
    helps = {}
    for cmd in HELP_COMMANDS:
        r = call([am] + cmd + ["--help"])
        text = (str(r["out"]) or str(r["err"]))[:HELP_LIMIT]
        helps[" ".join(cmd) or "(top)"] = {"code": r["code"], "text": text}
    out["help"] = helps
    for label, argv in (("sessions", [am, "sessions", "--json"]), ("terminal_list", [am, "terminal", "list", "--json"])):
        r = call(argv)
        entry: Dict[str, object] = {"code": r["code"], "error": first_line(str(r["err"]))}
        if r["code"] == 0:
            entry.update(shape(str(r["out"])))
        out[label] = entry
    return out


def am_db() -> Path:
    return Path(os.environ.get("JOSH360_AM_DB")
                or os.path.expanduser("~/Library/Application Support/agent-manager/state.db"))


def read_db(session_id: Optional[str]) -> Dict[str, object]:
    path = am_db()
    if not path.is_file():
        return {"exists": False}
    try:
        conn = sqlite3.connect("file:{}?mode=ro".format(quote(str(path))), uri=True, timeout=10)
        try:
            tables = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")]
            cols = [r[1] for r in conn.execute("PRAGMA table_info(sessions)")]
            statuses: List[str] = []
            if "status" in cols:
                statuses = sorted(str(r[0]) for r in conn.execute("SELECT DISTINCT status FROM sessions"))
            probe = None
            if session_id and "id" in cols:
                keep = [c for c in ("status", "tool", "archived", "group_name", "created_at", "last_status_at") if c in cols]
                row = conn.execute("SELECT {} FROM sessions WHERE id = ?".format(", ".join(keep) or "id"),
                                   (session_id,)).fetchone()
                probe = dict(zip(keep, row)) if row else "not found"
                # Which columns of this row hold something: says whether Agent Manager stores the tool's own
                # session id, without printing it.
                full = conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
                if full:
                    probe = {"row": probe, "filled_columns": [c for c, v in zip(cols, full) if v not in (None, "")]}
        finally:
            conn.close()
        return {"exists": True, "tables": tables, "sessions_columns": cols, "session_statuses": statuses,
                "probe_session": probe}
    except sqlite3.Error as e:
        return {"exists": True, "error": "{}: {}".format(type(e).__name__, e)[:ERR_LIMIT]}


def load_state() -> Dict[str, object]:
    try:
        return json.loads((probe_dir() / "state.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_state(state: Dict[str, object]) -> None:
    probe_dir().mkdir(parents=True, exist_ok=True)
    tmp = probe_dir() / "state.json.tmp"
    tmp.write_text(json.dumps(state, indent=2, sort_keys=True), encoding="utf-8")
    tmp.replace(probe_dir() / "state.json")


def spawn_once(am: str, state: Dict[str, object]) -> Dict[str, object]:
    earlier = state.get("spawn")
    attempts = int(state.get("spawn_attempts") or 0)
    # A spawn that worked is never repeated. One that was refused is tried at most SPAWN_TRIES times in all, in
    # case Agent Manager was simply not running; a refusal creates no session, so a retry cannot make two.
    # A spawn that timed out may have made a session, so it is not repeated either.
    if isinstance(earlier, dict) and (earlier.get("code") in (0, 124) or attempts >= SPAWN_TRIES):
        return earlier
    state["spawn_attempts"] = attempts + 1
    folder = home() / "state"
    argv = [am, "spawn", "--name", PROBE_NAME, "--tool", "claude", "--directory", str(folder),
            "--prompt", PROBE_PROMPT, "--json"]
    r = call(argv, timeout=120)
    result: Dict[str, object] = {"attempt": attempts + 1, "code": r["code"], "error": first_line(str(r["err"]))}
    if r["code"] == 0:
        result.update(shape(str(r["out"])))
        try:
            reply = json.loads(str(r["out"]))
            sid = reply.get("id") or reply.get("session_id") if isinstance(reply, dict) else None
            result["session_id"] = str(sid) if sid else None
        except ValueError:
            result["session_id"] = None
    state["spawn"] = result
    return result


def detached_test(state: Dict[str, object]) -> Dict[str, object]:
    """Start a child in its own session that writes a marker after MARKER_DELAY seconds; report it next pass."""
    marker = probe_dir() / "detached-marker"
    test = dict(state.get("detached") or {})
    if test.get("started") and "survived" not in test:
        if time.time() - float(test["started"]) >= MARKER_DELAY + 30:
            test["survived"] = marker.is_file()
    if not test.get("started"):
        probe_dir().mkdir(parents=True, exist_ok=True)
        if marker.exists():
            marker.unlink()
        script = "sleep {}; date -u +%Y-%m-%dT%H:%M:%SZ > '{}'".format(MARKER_DELAY, marker)
        devnull = open(os.devnull, "r+")
        try:
            subprocess.Popen(["/bin/sh", "-c", script], stdin=devnull, stdout=devnull, stderr=devnull,
                             start_new_session=True, close_fds=True)
        finally:
            devnull.close()
        test["started"] = time.time()
    state["detached"] = test
    return test


def build_report() -> Dict[str, object]:
    state = load_state()
    # No timestamp of its own: the report changes, and so is pushed, only when an answer changes.
    report: Dict[str, object] = {"job": "agent-manager-probe",
                                 "env_names": sorted(k for k in os.environ if k.startswith("AGENT_MANAGER")),
                                 "path": os.environ.get("PATH", "")}
    am = find_bin("agent-manager", "JOSH360_AM_BIN")
    claude = find_bin("claude", "JOSH360_CLAUDE_BIN")
    report["claude"] = {"path": claude,
                        "version": first_line(str(call([claude, "--version"])["out"])) if claude else None}
    report["agent_manager"] = {"path": am}
    if am:
        report["agent_manager"].update(read_cli(am))  # type: ignore[union-attr]
        report["spawn"] = spawn_once(am, state)
    spawned = report.get("spawn") or {}
    report["database"] = read_db(spawned.get("session_id") if isinstance(spawned, dict) else None)
    report["detached"] = detached_test(state)
    save_state(state)
    return report


def main() -> int:
    try:
        report = build_report()
    except Exception as e:  # noqa: BLE001 - the report is the only output; a crash must still say what broke
        report = {"job": "agent-manager-probe", "ok": False, "error": "{}: {}".format(type(e).__name__, e)[:ERR_LIMIT]}
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
