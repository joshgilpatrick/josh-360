#!/usr/bin/env python3
"""JP-119: put a job switched off by `retire-leftover-jobs` back, from its archive folder.

    python3 scripts/restore_retired_job.py <archive folder>            move the files home, load the job if it was loaded
    python3 scripts/restore_retired_job.py <archive folder> --dry-run  say what it would do, change nothing

The archive folder (~/Archive/josh-360-retired/<date>/<name>/) holds `retired.json`, written when the job was
retired: the job's label, where its plist and data folder came from, and whether the job was loaded. Restoring moves
the plist back into ~/Library/LaunchAgents and the data folder back to where it was, then runs
`launchctl bootstrap gui/<uid> <plist>` only if the job was loaded when it was retired. The files come back byte for
byte, because they were moved, not copied.

It refuses, and changes nothing, when a plist or data folder is already in the place it would restore to, or when
`retired.json` is missing or does not say what it should. Archives from JP-100 and JP-111 have a README with their own
commands instead. Exit 0 on success, 1 when it refused or the job would not load. Python 3.9, standard library only;
the only program it runs is `launchctl` (override with JOSH360_LAUNCHCTL for tests).
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import List

sys.dont_write_bytecode = True


def launchctl() -> str:
    return os.environ.get("JOSH360_LAUNCHCTL", "launchctl")


def main(argv: List[str]) -> int:
    args = [a for a in argv if a != "--dry-run"]
    dry = "--dry-run" in argv
    if len(args) != 1:
        print(__doc__)
        return 2
    folder = Path(args[0]).expanduser()
    try:
        record = json.loads((folder / "retired.json").read_text(encoding="utf-8"))
        label = record["label"]
        plist = record.get("plist")
        data = record.get("data")
        was_loaded = bool(record["was_loaded"])
        moves = []
        if plist:
            moves.append((folder / plist["name"], Path(plist["original_dir"]) / plist["name"]))
        if data:
            moves.append((folder / data["name"], Path(data["original"])))
        if not isinstance(label, str) or not label or record.get("schema") != 1:
            raise ValueError("retired.json does not say what it should")
    except (OSError, ValueError, KeyError, TypeError) as e:
        print("restore: cannot read {}: {}".format(folder / "retired.json", e.__class__.__name__))
        return 1

    for src, dst in moves:
        if not os.path.lexists(str(src)):
            print("restore: {} is missing from the archive; nothing changed".format(src))
            return 1
        if os.path.lexists(str(dst)):
            print("restore: {} already exists; nothing changed".format(dst))
            return 1
    for src, dst in moves:
        print("{} {} -> {}".format("would move" if dry else "moved", src, dst))
        if not dry:
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(src), str(dst))
    if was_loaded and plist:
        target = Path(plist["original_dir"]) / plist["name"]
        domain = "gui/{}".format(os.getuid())
        if dry:
            print("would load {}".format(label))
            return 0
        try:
            r = subprocess.run([launchctl(), "bootstrap", domain, str(target)], stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, universal_newlines=True, timeout=60)
        except (OSError, subprocess.SubprocessError) as e:
            print("restore: launchctl failed: {}".format(e.__class__.__name__))
            return 1
        if r.returncode != 0:
            print("restore: launchctl bootstrap exited {}; the files are back, load the job by hand".format(r.returncode))
            return 1
        print("loaded {}".format(label))
    else:
        print("{} was not loaded when it was retired, so it is not loaded now".format(label))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
