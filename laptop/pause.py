#!/usr/bin/env python3
"""The pause switch (JP-105): stop the laptop following josh-360, or let it follow again.

    python3 ~/.josh-360/repo/laptop/pause.py on       stop following (creates ~/.josh-360/PAUSED)
    python3 ~/.josh-360/repo/laptop/pause.py off      follow again
    python3 ~/.josh-360/repo/laptop/pause.py status   say which it is

From the cloud, pushing a branch named `laptop-pause` to josh-360 pauses it too, and deleting
that branch resumes it. While paused, the `follow` job still reports "paused" on laptop-status.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.dont_write_bytecode = True  # keep the laptop's copy clean
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import Lane, now_utc, pause_file  # noqa: E402


def main(argv) -> int:
    switch = pause_file()
    if argv == ["on"]:
        lane = Lane()
        lane.mkdir(switch.parent)
        lane.write_text(switch, "paused at {}\n".format(now_utc()))
        print("paused: the laptop will not install new changes until you run 'pause.py off'")
    elif argv == ["off"]:
        if switch.exists():
            Lane().check(switch).unlink()
        print("following: the next follow run installs main")
    elif argv == ["status"]:
        print("paused (local switch)" if switch.exists() else "following (no local switch; "
              "a laptop-pause branch on GitHub would also pause it)")
    else:
        print(__doc__.strip().splitlines()[2].strip())
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
