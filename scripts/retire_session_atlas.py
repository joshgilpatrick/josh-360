#!/usr/bin/env python3
"""JP-111: switch off the old Session Atlas and archive its stores, as a one-time JP-105 job.

    python3 scripts/retire_session_atlas.py            do it, print one JSON report
    python3 scripts/retire_session_atlas.py --dry-run  say what it would do, change nothing

Session Atlas moved into josh-360 (apps/session-atlas) and reads sessions from the ledger. The old copy ran from
claude-360 as the launchd job `com.eventus.claude-atlas`, with its own `~/.claude/atlas/atlas.db`, its own cost
ledger `~/.claude/cost-ledger/ledger.db`, and hook entries in `~/.claude/settings.json`. This job retires all of it.
Nothing is deleted: everything moves into ~/Archive/josh-360-retired/<date>/session-atlas/ with a README that says
how to put it back. In order:

  0. Wait (exit 1, so the runner tries again later) until the `ledger-backfill` job has succeeded, because the
     backfill reads the old atlas.db for session lineage and titles.
  1. If the old job is loaded, `launchctl bootout gui/<uid>/com.eventus.claude-atlas`, then check it is gone.
  2. Move its plist into the archive.
  3. Take the old Atlas hook entries out of ~/.claude/settings.json (a backup goes into the archive first, owner
     only). Only commands naming atlas-hook.js, atlas-removal-guard.js or jira-link-hook.sh are removed. Left in
     place, the old removal guard would block every `git worktree remove`, because its service is gone.
     Josh 360's own hook dispatcher now carries the guard and the Jira link hook (hooks/PreToolUse, hooks/PostToolUse).
  4. If ~/.josh-360/state/cache.db does not exist yet, seed it with a consistent copy of the old cost ledger, so cost
     history, pricing and Jira links carry over. An existing cache.db is never touched.
  5. Move atlas.db and the old cost ledger (each with its -wal and -shm) into the archive. Nothing writes to them
     afterwards: the service is off, and their hooks are out of settings.json.

It touches only that label, those files and the new archive folder, never overwrites an archive file, and is safe to
run twice. Exit 0 when everything is switched off and archived (or was never there); any other exit makes the runner
try again (the job is `every: once`). With no `launchctl` at all (not a Mac) it changes nothing and exits 0 with
result "skipped". Python 3.9, standard library only; the only program it runs is `launchctl` (override with
JOSH360_LAUNCHCTL for tests). The report holds counts and names, never session ids, titles or paths of sessions.
"""
from __future__ import annotations

import datetime
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
from pathlib import Path
from typing import Dict, List, Optional

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from laptop import common  # noqa: E402

LABEL = "com.eventus.claude-atlas"
OLD_HOOK = re.compile(r"(atlas-hook\.js|atlas-removal-guard\.js|jira-link-hook\.sh)")
DB_SUFFIXES = ("", "-wal", "-shm")


def launchctl() -> str:
    return os.environ.get("JOSH360_LAUNCHCTL", "launchctl")


def today() -> str:
    return os.environ.get("JOSH360_TODAY") or datetime.date.today().isoformat()


def _run(args: List[str]) -> subprocess.CompletedProcess:
    return subprocess.run([launchctl()] + args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          universal_newlines=True, timeout=60)


def is_loaded(domain: str) -> bool:
    return _run(["print", "{}/{}".format(domain, LABEL)]).returncode == 0


def backfill_done() -> bool:
    record = common.read_json(common.state_dir() / "jobs-state.json", {}).get("ledger-backfill", {})
    return record.get("last_result") == 0


def archive_folder(home: Path) -> Path:
    base = home / "Archive" / "josh-360-retired" / today()
    folder = base / "session-atlas"
    n = 2
    while folder.exists():  # never write into an earlier archive
        folder = base / "session-atlas-{}".format(n)
        n += 1
    return folder


def strip_old_hooks(data: Dict[str, object]) -> Dict[str, int]:
    """Remove the old Atlas command hooks from a parsed settings.json, in place. Returns counts per hook file name."""
    removed: Dict[str, int] = {}
    hooks = data.get("hooks")
    if not isinstance(hooks, dict):
        return removed
    for event in list(hooks):
        groups = hooks[event]
        if not isinstance(groups, list):
            continue
        kept_groups = []
        for group in groups:
            inner = group.get("hooks") if isinstance(group, dict) else None
            if not isinstance(inner, list):
                kept_groups.append(group)
                continue
            kept = []
            for h in inner:
                m = OLD_HOOK.search(str(h.get("command", ""))) if isinstance(h, dict) else None
                if m:
                    removed[m.group(1)] = removed.get(m.group(1), 0) + 1
                else:
                    kept.append(h)
            if kept:
                group = dict(group, hooks=kept)
                kept_groups.append(group)
            # a group whose every hook was an Atlas hook is dropped whole
        if kept_groups:
            hooks[event] = kept_groups
        else:
            del hooks[event]
    return removed


def has_old_hooks(settings: Path) -> Optional[bool]:
    """True/False, or None when the file is missing or cannot be read (unknown is not "none")."""
    if not settings.is_file():
        return False
    try:
        return bool(OLD_HOOK.search(settings.read_text(encoding="utf-8")))
    except OSError:
        return None


def seed_cache(old_cost: Path, cache: Path) -> str:
    """A consistent copy of the old cost ledger as the new cache.db. Returns a result word."""
    if cache.exists():
        return "kept-existing"
    if not old_cost.is_file():
        return "no-old-cost-ledger"
    cache.parent.mkdir(parents=True, exist_ok=True)
    tmp = cache.with_name(cache.name + ".seed-tmp")
    if tmp.exists():
        tmp.unlink()
    src = sqlite3.connect("file:{}?mode=ro".format(old_cost), uri=True, timeout=30.0)
    try:
        dst = sqlite3.connect(str(tmp))
        try:
            src.backup(dst)
            ok = dst.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        finally:
            dst.close()
    finally:
        src.close()
    if not ok:
        tmp.unlink()
        raise sqlite3.DatabaseError("seed copy failed its integrity check")
    os.replace(str(tmp), str(cache))
    return "seeded"


def move_db(db: Path, dest: Path, actions: List[str], dry: bool) -> bool:
    """Move a SQLite file and its -wal/-shm into dest together. True when something was (or would be) moved."""
    moved = False
    for suffix in DB_SUFFIXES:
        f = db.with_name(db.name + suffix)
        if not f.is_file():
            continue
        if f.is_symlink():
            actions.append("{} is a link; left alone".format(f.name))
            continue
        moved = True
        if dry:
            actions.append("would move {} to the archive".format(f.name))
        else:
            dest.mkdir(parents=True, exist_ok=True)
            target = dest / (db.parent.name + "-" + f.name)  # atlas-atlas.db, cost-ledger-ledger.db
            if target.exists():
                raise FileExistsError(str(target))
            shutil.move(str(f), str(target))
            actions.append("moved {} to the archive".format(f.name))
    return moved


README = """# Retired: the old Session Atlas (JP-111)

Session Atlas now lives in josh-360 (`apps/session-atlas`) and reads sessions from the ledger. The old copy was
switched off on {date}. Nothing was deleted. In this folder:

- `{plist_name}`: the old launchd job (`{label}`)
- `atlas-atlas.db` (with `-wal` and `-shm`): the old index, focus text and artifact catalog (`~/.claude/atlas/atlas.db`)
- `cost-ledger-ledger.db` (with `-wal` and `-shm`): the old cost ledger (`~/.claude/cost-ledger/ledger.db`). Its tables
  were also copied into `~/.josh-360/state/cache.db`, which the new Atlas keeps up to date.
- `settings.json.bak`: `~/.claude/settings.json` as it was before the old Atlas hook entries were taken out (owner
  read only; it can hold credentials, so delete it once you have checked the new settings).

Put the old Atlas back (this needs the claude-360 checkout, and stops the new one first):

    launchctl bootout gui/$(id -u)/com.josh360.session-atlas
    mv "{folder}/{plist_name}" ~/Library/LaunchAgents/
    mkdir -p ~/.claude/atlas ~/.claude/cost-ledger
    mv "{folder}"/atlas-atlas.db* ~/.claude/atlas/    # then rename each to atlas.db, atlas.db-wal, atlas.db-shm
    mv "{folder}"/cost-ledger-ledger.db* ~/.claude/cost-ledger/    # likewise: ledger.db, ledger.db-wal, ledger.db-shm
    cp "{folder}/settings.json.bak" ~/.claude/settings.json
    launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/{plist_name}
"""


def finish(report: Dict[str, object], code: int) -> int:
    print(json.dumps(report, indent=2, sort_keys=True))
    return code


def main(argv: List[str]) -> int:
    dry = "--dry-run" in argv
    home = Path.home()
    domain = "gui/{}".format(os.getuid())
    plist = home / "Library" / "LaunchAgents" / (LABEL + ".plist")
    settings = home / ".claude" / "settings.json"
    atlas_db = home / ".claude" / "atlas" / "atlas.db"
    cost_db = home / ".claude" / "cost-ledger" / "ledger.db"
    cache = common.state_dir() / "cache.db"
    report: Dict[str, object] = {"job": "retire-session-atlas", "label": LABEL, "dry_run": dry, "actions": []}
    actions: List[str] = report["actions"]  # type: ignore[assignment]
    ok = True

    try:
        loaded = is_loaded(domain)
    except FileNotFoundError:
        report.update({"result": "skipped", "reason": "launchctl not found; not a Mac"})
        return finish(report, 0)
    except (OSError, subprocess.SubprocessError) as e:
        report.update({"result": "failed", "error": "launchctl: " + e.__class__.__name__})
        return finish(report, 1)

    has_old = loaded or plist.exists() or atlas_db.exists() or cost_db.exists() or has_old_hooks(settings) is not False
    if has_old and not backfill_done():
        report.update({"result": "waiting", "reason": "the ledger-backfill job has not succeeded yet; it reads the old atlas.db"})
        return finish(report, 1)

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
    if not ok:  # never touch the files while the old service may still be writing them
        report["result"] = "failed"
        return finish(report, 1)

    dest = archive_folder(home)
    try:
        if plist.is_file() and not plist.is_symlink():
            if dry:
                actions.append("would move the plist to the archive")
            else:
                dest.mkdir(parents=True, exist_ok=True)
                shutil.move(str(plist), str(dest / plist.name))
                actions.append("moved the plist to the archive")
        elif plist.is_symlink():
            actions.append("plist is a link; left alone")
            ok = False
        else:
            actions.append("no old plist; nothing to archive")

        old_hooks = has_old_hooks(settings)
        if old_hooks is None:
            actions.append("settings.json could not be read; hooks left alone")
            ok = False
        elif old_hooks:
            target = settings.resolve()
            try:
                data = json.loads(target.read_text(encoding="utf-8"))
                if not isinstance(data, dict):
                    raise ValueError("settings.json is not an object")
            except (OSError, ValueError) as e:
                actions.append("settings.json is not valid JSON ({}); hooks left alone".format(e.__class__.__name__))
                ok = False
            else:
                removed = strip_old_hooks(data)
                report["hooks_removed"] = removed
                if dry:
                    actions.append("would remove {} old hook entries from settings.json".format(sum(removed.values())))
                else:
                    dest.mkdir(parents=True, exist_ok=True)
                    bak = dest / "settings.json.bak"
                    shutil.copyfile(str(target), str(bak))
                    os.chmod(str(bak), 0o600)
                    tmp = target.with_name(target.name + ".josh360-tmp")
                    tmp.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
                    os.chmod(str(tmp), target.stat().st_mode & 0o777)
                    os.replace(str(tmp), str(target))
                    actions.append("removed {} old hook entries from settings.json".format(sum(removed.values())))
        else:
            actions.append("settings.json names no old Atlas hooks")

        if ok:
            try:
                seeded = seed_cache(cost_db, cache) if not dry else ("would-seed" if (cost_db.is_file() and not cache.exists()) else "not-needed")
            except (sqlite3.Error, OSError) as e:
                actions.append("seeding cache.db failed ({})".format(e.__class__.__name__))
                report["cache_db"] = "seed-failed"
                ok = False
            else:
                report["cache_db"] = seeded
                actions.append("cache.db: " + seeded)

        if ok:
            moved_atlas = move_db(atlas_db, dest, actions, dry)
            moved_cost = move_db(cost_db, dest, actions, dry)
            report["archived"] = {"atlas.db": moved_atlas, "cost-ledger": moved_cost}
            if not dry and (dest.exists()):
                (dest / "README.md").write_text(
                    README.format(plist_name=LABEL + ".plist", label=LABEL, date=today(), folder=dest), encoding="utf-8")
                report["archived_to"] = str(dest)
    except (OSError, shutil.Error) as e:
        actions.append("stopped: {}".format(e.__class__.__name__))
        ok = False

    report["result"] = "ok" if ok else "failed"
    return finish(report, 0 if ok else 1)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
