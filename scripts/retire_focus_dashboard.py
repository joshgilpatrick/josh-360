#!/usr/bin/env python3
"""JP-100: switch off the focus dashboard's launchd job and archive its plist, as a one-time JP-105 job.

    python3 scripts/retire_focus_dashboard.py            do it, print one JSON report
    python3 scripts/retire_focus_dashboard.py --dry-run  say what it would do, change nothing

The focus dashboard (`com.eventus.focus-dashboard`, port 8765) only reads focus files, and the focus loop is
retired (STATE.md is the one per-session record). The job is reversible: nothing is deleted.

  1. If the job is loaded, `launchctl bootout gui/<uid>/com.eventus.focus-dashboard`, then check it is gone.
  2. If its plist is in ~/Library/LaunchAgents, move it to
     ~/Archive/josh-360-retired/<date>/focus-dashboard/ with a README saying how to put it back.
  3. Read-only: count focus hooks still named in ~/.claude/settings.json (names of the hook scripts only)
     and the files in ~/.claude/session-focus/.

It touches only that one label, that one plist and the new archive folder, never overwrites an archive
file, and is safe to run twice. Exit 0 when the job is not loaded and its plist is archived or absent; any
other exit makes the runner try again (the job is `every: once`). With no `launchctl` at all (not a Mac) it
changes nothing and exits 0 with result "skipped". Python 3.9, standard library only; the
only thing it runs is `launchctl` (override the program with JOSH360_LAUNCHCTL for tests).
"""
from __future__ import annotations

import datetime
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Dict, List

sys.dont_write_bytecode = True

LABEL = "com.eventus.focus-dashboard"
FOCUS_HOOK = re.compile(r"(focus-(?:session-start|history-capture|session-end|completion-gate)\.py|session-focus-inject\.sh)")


def launchctl() -> str:
    return os.environ.get("JOSH360_LAUNCHCTL", "launchctl")


def today() -> str:
    return os.environ.get("JOSH360_TODAY") or datetime.date.today().isoformat()


def _run(args: List[str]) -> subprocess.CompletedProcess:
    return subprocess.run([launchctl()] + args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          universal_newlines=True, timeout=60)


def is_loaded(domain: str) -> bool:
    return _run(["print", "{}/{}".format(domain, LABEL)]).returncode == 0


def settings_focus_hooks(settings: Path) -> Dict[str, object]:
    """Read-only: which focus hook scripts the live settings.json still names. Names only, no other content."""
    if not settings.is_file():
        return {"settings_found": False, "focus_hooks_named": []}
    try:
        text = settings.read_text(encoding="utf-8")
    except OSError as e:
        return {"settings_found": True, "error": e.__class__.__name__, "focus_hooks_named": []}
    return {"settings_found": True, "focus_hooks_named": sorted(set(FOCUS_HOOK.findall(text)))}


def focus_files(folder: Path) -> Dict[str, object]:
    if not folder.is_dir():
        return {"folder_exists": False, "files": 0}
    return {"folder_exists": True, "files": sum(1 for p in folder.rglob("*") if p.is_file())}


def archive_folder(home: Path) -> Path:
    base = home / "Archive" / "josh-360-retired" / today()
    folder = base / "focus-dashboard"
    n = 2
    while folder.exists():  # never write into an earlier archive
        folder = base / "focus-dashboard-{}".format(n)
        n += 1
    return folder


README = """# Retired: the focus dashboard (JP-100)

`{plist_name}` was the launchd job for the focus dashboard on port 8765. It was switched off on {date}
because STATE.md is now the only per-session record. Nothing was deleted.

Put it back:

    mv "{folder}/{plist_name}" ~/Library/LaunchAgents/
    launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/{plist_name}

The dashboard script itself is in the claude-harness repo under `archive/focus/tools/` (see
`archive/focus/README.md` there; its `restore.sh` moves it back).
"""


def main(argv: List[str]) -> int:
    dry = "--dry-run" in argv
    home = Path.home()
    domain = "gui/{}".format(os.getuid())
    plist = home / "Library" / "LaunchAgents" / (LABEL + ".plist")
    report: Dict[str, object] = {"job": "retire-focus-dashboard", "label": LABEL, "dry_run": dry, "actions": []}
    actions: List[str] = report["actions"]  # type: ignore[assignment]
    ok = True

    try:
        loaded = is_loaded(domain)
    except FileNotFoundError:
        # No launchctl: not a Mac (a cloud session or a CI run). There is no launchd job to switch off here,
        # and nothing can be verified, so touch nothing.
        report.update({"result": "skipped", "reason": "launchctl not found; not a Mac"})
        print(json.dumps(report, indent=2, sort_keys=True))
        return 0
    except (OSError, subprocess.SubprocessError) as e:
        report.update({"result": "failed", "error": "launchctl: " + e.__class__.__name__})
        print(json.dumps(report, indent=2, sort_keys=True))
        return 1
    report["was_loaded"] = loaded
    if loaded:
        if dry:
            actions.append("would bootout " + LABEL)
        else:
            r = _run(["bootout", "{}/{}".format(domain, LABEL)])
            gone = not is_loaded(domain)
            actions.append("bootout " + LABEL + (" ok" if gone else " FAILED (exit {})".format(r.returncode)))
            ok = ok and gone
    else:
        actions.append("not loaded; nothing to bootout")

    if plist.is_file() and not plist.is_symlink():
        dest = archive_folder(home)
        if dry:
            actions.append("would move the plist to " + str(dest))
        else:
            dest.mkdir(parents=True)
            shutil.move(str(plist), str(dest / plist.name))
            (dest / "README.md").write_text(
                README.format(plist_name=plist.name, date=today(), folder=dest), encoding="utf-8")
            actions.append("moved the plist to " + str(dest))
            report["archived_to"] = str(dest)
    elif plist.is_symlink():
        actions.append("plist is a link; left alone")
        ok = False
    else:
        actions.append("no plist in ~/Library/LaunchAgents; nothing to archive")

    report["settings"] = settings_focus_hooks(home / ".claude" / "settings.json")
    report["session_focus"] = focus_files(home / ".claude" / "session-focus")
    report["result"] = "ok" if ok else "failed"
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
