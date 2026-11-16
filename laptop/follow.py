#!/usr/bin/env python3
"""The `follow` job (JP-105): keep the laptop's copy of josh-360 on `main` and installed.

1. If the pause switch is set (the file ~/.josh-360/PAUSED, or a `laptop-pause` branch on GitHub),
   report "paused" and install nothing.
2. Fetch `main`. If the laptop's copy has local changes, or `main` is not ahead of it, stop and
   report "failed": the copy only ever moves forward.
3. Move the copy to `main` and run the install script from it. If the install stops, move the copy
   back, so the laptop stays on the last good install.
4. Push the result to the `laptop-status` branch.

Exit 0 when passed or paused, 1 otherwise. Runs from the laptop's copy, ~/.josh-360/repo.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

sys.dont_write_bytecode = True  # keep the laptop's copy clean
sys.path.insert(0, str(Path(__file__).resolve().parent))
import status as status_branch  # noqa: E402
from common import MAIN_BRANCH, PAUSE_BRANCH, REPO_ROOT, Unexpected, git, now_utc, pause_file  # noqa: E402


def head(repo: Path) -> str:
    return git(["rev-parse", "HEAD"], repo).stdout.strip()


def paused(repo: Path) -> str:
    if pause_file().exists():
        return "paused by the local switch (the PAUSED file in the Josh 360 folder)"
    listing = git(["ls-remote", "--heads", "origin", PAUSE_BRANCH], repo)
    if listing.stdout.strip():
        return "paused by the {} branch on GitHub".format(PAUSE_BRANCH)
    return ""


def install(repo: Path) -> dict:
    result = subprocess.run(
        [sys.executable, str(repo / "laptop" / "install.py"), "--json"],
        cwd=str(repo), stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True,
    )
    sys.stdout.write(result.stdout)
    sys.stderr.write(result.stderr)
    lines = result.stdout.strip().splitlines()
    try:
        summary = json.loads(lines[-1]) if lines else {}
    except ValueError:
        summary = {}
    if result.returncode != 0 or summary.get("result") != "passed":
        summary["result"] = "failed"
        summary.setdefault("problems", 1)
    return summary


def follow(repo: Path = REPO_ROOT) -> dict:
    before = head(repo)
    git(["fetch", "--quiet", "origin", "+refs/heads/{0}:refs/remotes/origin/{0}".format(MAIN_BRANCH)], repo)
    main = git(["rev-parse", "refs/remotes/origin/" + MAIN_BRANCH], repo).stdout.strip()

    reason = paused(repo)
    if reason:
        return {"commit": before, "main": main, "result": "paused", "reason": reason, "counts": {}}

    if git(["status", "--porcelain", "--untracked-files=no"], repo).stdout.strip():
        return {"commit": before, "main": main, "result": "failed",
                "reason": "the laptop's copy has local changes; nothing was installed", "counts": {"problems": 1}}
    if before != main:
        ahead = git(["merge-base", "--is-ancestor", before, main], repo, check=False)
        if ahead.returncode != 0:
            return {"commit": before, "main": main, "result": "failed",
                    "reason": "main is not ahead of the installed commit; nothing was installed",
                    "counts": {"problems": 1}}
        git(["-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", main], repo)

    summary = install(repo)
    counts = {k: summary.get(k, 0) for k in ("changed", "unchanged", "problems")}
    if summary["result"] != "passed":
        if before != main:
            git(["-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", before], repo)
        return {"commit": before, "main": main, "result": "failed",
                "reason": "the install script stopped; the laptop stays on the last good install", "counts": counts}
    return {"commit": head(repo), "main": main, "result": "passed",
            "reason": "installed" if before != main or counts["changed"] else "already up to date",
            "counts": counts}


def main() -> int:
    try:
        outcome = follow()
    except Unexpected as e:
        print("follow: could not run: {}".format(e))
        return 1
    status = status_branch.make_status(outcome["commit"], outcome["main"], outcome["result"],
                                       outcome["reason"], outcome["counts"], now_utc())
    print("follow: {} ({}), commit {}".format(outcome["result"], outcome["reason"], outcome["commit"][:12]))
    try:
        print("status: " + status_branch.publish(status))
    except Unexpected as e:
        print("status: could not push: {}".format(e))
        return 1
    return 0 if outcome["result"] in ("passed", "paused") else 1


if __name__ == "__main__":
    sys.exit(main())
