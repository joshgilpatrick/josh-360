#!/usr/bin/env python3
"""The JP-96 laptop inventory as a one-time JP-105 job (jobs.yaml, id `inventory`, `every: once`).

The runner starts this with no arguments from ~/.josh-360/repo and publishes what it prints to the
laptop-status branch as reports/inventory.json. It runs the same read-only script Josh would run by hand,
writing to standard output instead of a file. It leaves out the folders macOS may guard with a privacy
prompt (iCloud, OneDrive, Desktop, Documents, Downloads), because no one is at the screen to answer it,
and it does not run brew, which writes its own cache even for `brew services list` (Homebrew's services
still show up as homebrew.mxcl.* launchd plists). It writes no file at all, not even bytecode.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import laptop_inventory  # noqa: E402

JOB_ARGS = ["--out", "-", "--skip-prompting-folders", "--no-brew"]


def main() -> int:
    return laptop_inventory.main(JOB_ARGS)


if __name__ == "__main__":
    sys.exit(main())
