#!/usr/bin/env python3
"""The `graph-runner` job (JP-117): one pass of the runner every five minutes, and always exit 0.

The job runner publishes a report only when the job exits 0, and a pass that found a problem is the report worth
publishing, so a problem is in the JSON (`status`, `loop.stale`), never in the exit code. Under host `job` it runs
`tick()`; under host `terminal` the loop does the ticking in an Agent Manager terminal and this job only checks the
loop's heartbeat. Python 3.9, standard library only. No model call.
"""
import json
import sys
import time
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from runner_lib import paths, tick  # noqa: E402


def main(out=None, now=time.time) -> int:
    out = out or sys.stdout
    try:
        if paths.settings()["host"] == "terminal":
            report = tick.heartbeat_report(now())
        else:
            report = tick.tick(now=now)
    except Exception as err:  # noqa: BLE001
        paths.log("tick_job: {}: {}".format(type(err).__name__, str(err)[:200]))
        report = {"status": "error", "error": type(err).__name__}
    out.write(json.dumps(report, sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
