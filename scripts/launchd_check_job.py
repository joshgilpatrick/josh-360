#!/usr/bin/env python3
"""JP-119: the startup-list check (laptop/check_jobs.py) as a daily JP-105 job (jobs.yaml, id `launchd-check`).

The runner starts this with no arguments and publishes what it prints to the laptop-status branch as
reports/launchd-check.json, so a cloud session can see any difference between what runs on the laptop and the
startup list without asking Josh. It changes nothing on the laptop. The report holds job labels, plist file names and
counts only. It exits 0 even when it finds differences, because the runner publishes a report only for a job that
exits 0; the report's `ok` and `differences` say what it found.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "laptop"))
import check_jobs  # noqa: E402
import common  # noqa: E402


def main() -> int:
    try:
        report = check_jobs.build_report()
    except common.Unexpected as e:
        print(json.dumps({"job": "launchd-check", "ok": False, "error": str(e)[:200]}, indent=2, sort_keys=True))
        return 0
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
