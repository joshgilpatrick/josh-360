#!/usr/bin/env python3
"""The Josh 360 job runner (JP-105). launchd starts it every 5 minutes.

It is started by one entry in the macbook-automations startup list
(launchd/com.jgilpatrick.josh-360-jobs.plist), so Josh 360 has no login job of its own.

Each pass it reads jobs.yaml and runs every job that is due, one at a time, in file order:

- `every: 10m` (or `1h`, `1d`) runs again once that long has passed since its last run.
- `every: once` runs until it succeeds once, retrying at most hourly.
- `report: true` means the job prints one JSON value. The runner puts it on the laptop-status
  branch as reports/<id>.json (at most 1 MB). This is how the inventory (JP-96) comes back. The newest output is
  also kept on the laptop as state/reports/<id>.json (JP-166), where the validation collectors read it.

Each job's output goes to ~/.josh-360/logs/<id>.log. When the runs happened is kept in
~/.josh-360/state/jobs-state.json. A lock stops two passes running at once.

    python3 laptop/run_jobs.py          one pass
    python3 laptop/run_jobs.py --list   show each job and when it is next due
"""
from __future__ import annotations

import fcntl
import json
import subprocess
import sys
import time
from pathlib import Path
from typing import Dict, List

sys.dont_write_bytecode = True  # keep the laptop's copy clean
sys.path.insert(0, str(Path(__file__).resolve().parent))
import status as status_branch  # noqa: E402
from common import (REPO_ROOT, Lane, Unexpected, dump_json, load_jobs, logs_dir, now_utc,  # noqa: E402
                    read_json, require_laptop_copy, state_dir)

ONCE_RETRY_SECONDS = 3600
REPORT_LIMIT = 1_000_000


def is_due(job: Dict[str, object], record: Dict[str, object], now: float) -> bool:
    last = float(record.get("last_run", 0) or 0)
    if job["every"] is None:
        if record.get("last_result") == 0:
            return False
        return not last or now - last >= ONCE_RETRY_SECONDS
    return not last or now - last >= float(job["every"])  # type: ignore[arg-type]


def run_job(job: Dict[str, object], lane: Lane) -> int:
    log = logs_dir() / "{}.log".format(job["id"])
    started = now_utc()
    try:
        result = subprocess.run(
            [sys.executable, str(REPO_ROOT / str(job["run"]))], cwd=str(REPO_ROOT),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True,
            timeout=float(job["timeout"]),  # type: ignore[arg-type]
        )
        code, out, err = result.returncode, result.stdout, result.stderr
    except subprocess.TimeoutExpired:
        code, out, err = 124, "", "timed out after {}s\n".format(job["timeout"])

    shown_out = "(report output, {} bytes)\n".format(len(out)) if job["report"] else out
    lane.append_text(log, "=== {} exit {}\n{}{}".format(started, code, shown_out, err))

    if job["report"] and code == 0:
        try:
            if len(out.encode("utf-8")) > REPORT_LIMIT:
                raise ValueError("report is larger than 1 MB")
            data = json.loads(out)
            # Keep the newest output here too, before the push: the validation collectors (JP-166) read it from this
            # folder, and a push that fails must not cost them the reading.
            lane.mkdir(state_dir() / "reports")
            lane.write_text(state_dir() / "reports" / "{}.json".format(job["id"]), out)
            print("{}: report {}".format(job["id"], status_branch.publish(None, {str(job["id"]): data})))
        except (ValueError, Unexpected) as e:
            lane.append_text(log, "report not published: {}\n".format(e))
            code = 1
    return code


def one_pass(lane: Lane) -> int:
    state_path = state_dir() / "jobs-state.json"
    state = read_json(state_path, {})
    jobs = load_jobs(REPO_ROOT)
    failures = 0
    done: List[str] = []
    i = 0
    while i < len(jobs):
        job = jobs[i]
        i += 1
        if job["id"] in done or not is_due(job, state.get(job["id"], {}), time.time()):
            continue
        code = run_job(job, lane)
        done.append(str(job["id"]))
        print("{}: exit {}".format(job["id"], code))
        failures += code != 0
        state[job["id"]] = {"last_run": time.time(), "last_result": code}
        lane.write_text(state_path, dump_json(state))
        if job["id"] == "follow":
            # follow may have moved the copy to a newer main: read the list again.
            jobs = load_jobs(REPO_ROOT)
            i = 0
    return 1 if failures else 0


def list_jobs() -> int:
    state = read_json(state_dir() / "jobs-state.json", {})
    now = time.time()
    for job in load_jobs(REPO_ROOT):
        record = state.get(job["id"], {})
        when = "due now" if is_due(job, record, now) else "not due"
        every = "once" if job["every"] is None else "{}s".format(job["every"])
        print("{:<20} every {:<8} {:<8} last exit {}".format(job["id"], every, when, record.get("last_result", "-")))
    return 0


def main(argv: List[str]) -> int:
    try:
        if argv == ["--list"]:
            return list_jobs()
        require_laptop_copy()
        lane = Lane()
        lane.mkdir(state_dir())
        lane.mkdir(logs_dir())
        with open(str(lane.check(state_dir() / "run.lock")), "w") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                print("run_jobs: another pass is running")
                return 0
            return one_pass(lane)
    except Unexpected as e:
        print("run_jobs: stopped: {}".format(e))
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
