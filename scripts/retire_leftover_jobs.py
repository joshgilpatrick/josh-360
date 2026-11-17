#!/usr/bin/env python3
"""JP-119: switch off three leftover launchd jobs and archive them, as a one-time JP-105 job.

    python3 scripts/retire_leftover_jobs.py            do it, print one JSON report
    python3 scripts/retire_leftover_jobs.py --dry-run  say what it would do, change nothing

The JP-96 laptop inventory marked these jobs "dismantle", and Josh agreed at the JP-106 sitting:

  com.eventus.qa-waker-watchdog      left over from one QA sprint; its last run exited 1
  com.eventus.clickup-notion-sync    plist installed, never loaded, never logged
  com.omnara.daemon                  Omnara, retired at the sitting (question 4); its folder ~/.omnara is archived too

For each one, in order:

  1. If the job is loaded, `launchctl bootout gui/<uid>/<label>`, then check it is gone.
  2. Move its plist from ~/Library/LaunchAgents into ~/Archive/josh-360-retired/<date>/<name>/.
  3. Only when the job is gone: move its data folder (Omnara's ~/.omnara) into the same archive folder with a
     rename. If the rename cannot be done in place (another volume), the folder stays where it is and the
     report says so; nothing is ever copied and then removed.
  4. Write `retired.json` and a README beside what moved. `scripts/restore_retired_job.py <archive folder>` reads
     them and puts everything back, loading the job again if it was loaded.

Nothing is deleted. A permanent delete waits on docs/phase-1-deletion-list.md for Josh's one-sitting approval. It
touches only these three labels, their plists and Omnara's folder, never overwrites an archive file, and is safe to
run twice. Exit 0 when each job is not loaded and its plist is archived or absent; any other exit makes the runner
try again (the job is `every: once`). With no `launchctl` at all (not a Mac) it changes nothing and exits 0 with
result "skipped". Python 3.9, standard library only; the only program it runs is `launchctl` (override with
JOSH360_LAUNCHCTL for tests).
"""
from __future__ import annotations

import datetime
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Dict, List, Optional

sys.dont_write_bytecode = True

ITEMS = [
    {"name": "qa-waker-watchdog", "label": "com.eventus.qa-waker-watchdog", "data": None,
     "why": "it was left over from one QA sprint and its last run exited 1 (JP-96 verdict: dismantle)"},
    {"name": "clickup-notion-sync", "label": "com.eventus.clickup-notion-sync", "data": None,
     "why": "it was never loaded and never logged (JP-96 verdict: dismantle)"},
    {"name": "omnara", "label": "com.omnara.daemon", "data": ".omnara",
     "why": "Josh retired Omnara at the JP-106 sitting, question 4 (docs/decisions.md); Claude Code's own remote control "
            "and Agent Manager cover it"},
]

README = """# Retired: {label} (JP-119)

Switched off on {date} because {why}. Nothing was deleted.

Put it back (this reads `retired.json` in this folder, moves the files home and loads the job again if it was loaded):

    python3 ~/.josh-360/repo/scripts/restore_retired_job.py "{folder}"

Permanent deletion waits on `docs/phase-1-deletion-list.md` in josh-360 for Josh's approval.
"""


def launchctl() -> str:
    return os.environ.get("JOSH360_LAUNCHCTL", "launchctl")


def today() -> str:
    return os.environ.get("JOSH360_TODAY") or datetime.date.today().isoformat()


def _run(args: List[str]) -> subprocess.CompletedProcess:
    return subprocess.run([launchctl()] + args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          universal_newlines=True, timeout=60)


def is_loaded(domain: str, label: str) -> bool:
    return _run(["print", "{}/{}".format(domain, label)]).returncode == 0


def archive_folder(home: Path, name: str) -> Path:
    base = home / "Archive" / "josh-360-retired" / today()
    folder = base / name
    n = 2
    while folder.exists():  # never write into an earlier archive
        folder = base / "{}-{}".format(name, n)
        n += 1
    return folder


def retire_one(item: Dict[str, Optional[str]], home: Path, domain: str, dry: bool) -> Dict[str, object]:
    label = str(item["label"])
    plist = home / "Library" / "LaunchAgents" / (label + ".plist")
    data = home / str(item["data"]) if item["data"] else None
    row: Dict[str, object] = {"label": label, "actions": [], "ok": True}
    actions: List[str] = row["actions"]  # type: ignore[assignment]

    loaded = is_loaded(domain, label)
    row["was_loaded"] = loaded
    if loaded:
        if dry:
            actions.append("would bootout " + label)
        else:
            r = _run(["bootout", "{}/{}".format(domain, label)])
            gone = not is_loaded(domain, label)
            actions.append("bootout " + label + (" ok" if gone else " FAILED (exit {})".format(r.returncode)))
            row["ok"] = gone
    else:
        actions.append("not loaded; nothing to bootout")
    job_gone = not loaded or dry or bool(row["ok"])

    move_plist = plist.is_file() and not plist.is_symlink()
    if plist.is_symlink():
        actions.append("plist is a link; left alone")
        row["ok"] = False
    move_data = bool(data and data.is_dir() and not data.is_symlink())
    if data and data.is_symlink():
        actions.append("{} is a link; left alone".format(data.name))
    if not move_plist and not plist.is_symlink():
        actions.append("no plist in ~/Library/LaunchAgents; nothing to archive")

    if (move_plist or move_data) and job_gone:
        dest = archive_folder(home, str(item["name"]))
        if dry:
            actions.append("would archive to " + str(dest))
        else:
            dest.mkdir(parents=True)
            record: Dict[str, object] = {"schema": 1, "label": label, "retired_on": today(), "was_loaded": loaded,
                                         "plist": None, "data": None}
            if move_plist:
                shutil.move(str(plist), str(dest / plist.name))
                record["plist"] = {"name": plist.name, "original_dir": str(plist.parent)}
                actions.append("moved the plist to " + str(dest))
            if move_data and data is not None:
                target = dest / ("data-" + data.name)
                try:
                    os.rename(str(data), str(target))  # a rename only: never a copy followed by a delete
                    record["data"] = {"name": target.name, "original": str(data)}
                    actions.append("moved {} to the archive".format(data.name))
                except OSError as e:
                    actions.append("{} left in place ({})".format(data.name, e.__class__.__name__))
                    row["data_left_in_place"] = True
            (dest / "retired.json").write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")
            (dest / "README.md").write_text(
                README.format(label=label, date=today(), why=item["why"], folder=dest), encoding="utf-8")
            row["archived_to"] = str(dest)
    elif move_data and not job_gone:
        actions.append("{} left in place: the job is still loaded".format(data.name if data else ""))
    return row


def main(argv: List[str]) -> int:
    dry = "--dry-run" in argv
    home = Path.home()
    domain = "gui/{}".format(os.getuid())
    report: Dict[str, object] = {"job": "retire-leftover-jobs", "dry_run": dry, "items": []}
    try:
        for item in ITEMS:
            report["items"].append(retire_one(item, home, domain, dry))  # type: ignore[union-attr]
    except FileNotFoundError:
        # No launchctl: not a Mac (a cloud session or a CI run). Nothing can be verified, so touch nothing.
        report.update({"items": [], "result": "skipped", "reason": "launchctl not found; not a Mac"})
        print(json.dumps(report, indent=2, sort_keys=True))
        return 0
    except (OSError, subprocess.SubprocessError) as e:
        report["result"] = "failed"
        report["error"] = e.__class__.__name__
        print(json.dumps(report, indent=2, sort_keys=True))
        return 1
    ok = all(bool(r["ok"]) for r in report["items"])  # type: ignore[union-attr]
    report["result"] = "ok" if ok else "failed"
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
