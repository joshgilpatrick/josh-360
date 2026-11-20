#!/usr/bin/env python3
"""The Josh 360 job runner (JP-105). launchd starts it every 5 minutes.

It is started by one entry in the macbook-automations startup list
(launchd/com.jgilpatrick.josh-360-jobs.plist), so Josh 360 has no login job of its own.

Each pass it reads jobs.yaml and runs every job that is due, one at a time, in file order:

- `every: 10m` (or `1h`, `1d`) runs again once that long has passed since its last run.
- `every: once` runs until it succeeds once, retrying at most hourly. A failure that won't fix itself (JP-183: exit 78
  after a `needs-fix: <why>` line, or an import or syntax error) is not retried hourly: the job waits until its inputs
  change (the laptop copy moves to another commit, or its script changes) or Josh resumes it, and doctor names it.
- `report: true` means the job prints one JSON value. The runner puts it on the laptop-status
  branch as reports/<id>.json (at most 1 MB). This is how the inventory (JP-96) comes back. The newest output is
  also kept on the laptop as state/reports/<id>.json (JP-166), where the validation collectors read it.

Each job's output goes to ~/.josh-360/logs/<id>.log. When the runs happened is kept in
~/.josh-360/state/jobs-state.json. A lock stops two passes running at once.

    python3 laptop/run_jobs.py          one pass
    python3 laptop/run_jobs.py --list   show each job and when it is next due
    python3 laptop/run_jobs.py --resume <id>   run a job that is waiting for a fix on the next pass
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
import failure_kinds as kinds  # noqa: E402
import status as status_branch  # noqa: E402
from common import (REPO_ROOT, Lane, Unexpected, dump_json, load_jobs, logs_dir, now_utc,  # noqa: E402
                    read_json, require_laptop_copy, state_dir)

ONCE_RETRY_SECONDS = 3600
REPORT_LIMIT = 1_000_000
_stderr: Dict[str, str] = {}        # each job's stderr from this pass, for the reason of a failure


def job_inputs(job: Dict[str, object]) -> str:
    """What a once job's run depends on that a fix would change: the laptop copy's commit, its jobs.yaml entry and its
    script (JP-183)."""
    entry = {k: job.get(k) for k in ("id", "run", "timeout", "report")}
    return kinds.fingerprint({"commit": kinds.repo_commit(REPO_ROOT), "job": entry,
                              "script": kinds.file_hash(REPO_ROOT / str(job["run"]))})


def waits_for_fix(job: Dict[str, object], record: Dict[str, object]) -> bool:
    """A once job whose last failure won't fix itself, and nothing it depends on has changed since."""
    return (job["every"] is None and record.get("last_result") not in (None, 0) and record.get("kind") == kinds.NEEDS_FIX
            and record.get("inputs") == job_inputs(job))


def is_due(job: Dict[str, object], record: Dict[str, object], now: float) -> bool:
    last = float(record.get("last_run", 0) or 0)
    if job["every"] is None:
        if record.get("last_result") == 0:
            return False
        if record.get("kind") == kinds.NEEDS_FIX:
            return not waits_for_fix(job, record)      # its inputs changed (or it was resumed): run it now
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
    _stderr[str(job["id"])] = err

    shown_out = "(report output, {} bytes)\n".format(len(out)) if job["report"] else out
    lane.append_text(log, "=== {} exit {}\n{}{}".format(started, code, shown_out, err))

    if job["report"] and code == 0:
        try:
            if len(out.encode("utf-8")) > REPORT_LIMIT:
                raise ValueError("report is larger than 1 MB")
            data = json.loads(out)
            # Keep the newest output here too, before the push: the validation collectors (JP-166) read it from this
            # folder, and a push that fails must not cost them the reading.
            try:
                lane.mkdir(state_dir() / "reports")
                lane.write_text(state_dir() / "reports" / "{}.json".format(job["id"]), out)
            except OSError as e:   # a full disk must not stop the pass or cost the job its publish
                lane.append_text(log, "local report copy not kept: {}\n".format(e))
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
        state[job["id"]] = run_record(job, code, _stderr.pop(str(job["id"]), ""))
        lane.write_text(state_path, dump_json(state))
        if job["id"] == "follow":
            # follow may have moved the copy to a newer main: read the list again.
            jobs = load_jobs(REPO_ROOT)
            i = 0
    return 1 if failures else 0


def run_record(job: Dict[str, object], code: int, err: str) -> Dict[str, object]:
    """What jobs-state.json keeps for one run. A failure also keeps its reason code, its kind and its last line,
    shortened and screened for patient data (JP-183); one that won't fix itself keeps what it depended on."""
    out: Dict[str, object] = {"last_run": time.time(), "last_result": code}
    if code != 0:
        reason = kinds.job_reason(code, err)
        out.update(reason=reason, kind=kinds.kind_of(reason), said=kinds.short(kinds.last_line(err)))
        if out["kind"] == kinds.NEEDS_FIX:
            out["inputs"] = job_inputs(job)
    return out


def resume(job_id: str, lane: Lane) -> int:
    """Let a job that waits for a fix run on the next pass."""
    path = state_dir() / "jobs-state.json"
    state = read_json(path, {})
    rec = state.get(job_id)
    if not isinstance(rec, dict) or rec.get("kind") != kinds.NEEDS_FIX:
        print("run_jobs: {} is not waiting for a fix".format(job_id))
        return 1
    rec["inputs"] = "resumed"
    lane.write_text(path, dump_json(state))
    print("run_jobs: {} runs on the next pass".format(job_id))
    return 0


def list_jobs() -> int:
    state = read_json(state_dir() / "jobs-state.json", {})
    now = time.time()
    for job in load_jobs(REPO_ROOT):
        record = state.get(job["id"], {})
        when = "due now" if is_due(job, record, now) else ("needs fix" if waits_for_fix(job, record) else "not due")
        every = "once" if job["every"] is None else "{}s".format(job["every"])
        print("{:<20} every {:<8} {:<8} last exit {}".format(job["id"], every, when, record.get("last_result", "-")))
    return 0


def main(argv: List[str]) -> int:
    try:
        if argv == ["--list"]:
            return list_jobs()
        require_laptop_copy()
        lane = Lane()
        if len(argv) == 2 and argv[0] == "--resume":
            return resume(argv[1], lane)
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
