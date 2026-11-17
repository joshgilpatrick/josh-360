#!/usr/bin/env python3
"""JP-152: the doctor as a daily job, so the cloud can read how the laptop is without Josh running anything.

It prints the doctor's JSON (scripts/doctor.py --json) and always exits 0. The runner publishes a report only when the
job exits 0, and a laptop with a failing check is exactly the report worth publishing: the failure is in the JSON
(`ok`, `summary` and each check's `status`), not in this job's exit code. Read it from the cloud with
`python3 laptop/status.py show doctor`. Python 3.9, standard library only.
"""
import sys
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import doctor  # noqa: E402

if __name__ == "__main__":
    doctor.main(["--json"])
    sys.exit(0)
