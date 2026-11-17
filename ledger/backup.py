"""Daily backup of the ledger (JP-107, Task 8). Python 3.9, standard library only.

    python3 ledger/backup.py    copy the ledger, check the copy, compress it, keep 14 daily and 8 weekly copies

A copy is made with SQLite's own backup call, so it is safe while the walker and the recorder write. The copy is
checked with PRAGMA integrity_check, and a copy that fails is removed, never kept. Copies sit in
~/.josh-360/backups/ as `ledger-<YYYY-MM-DD>.db.gz`. There is no upload and no setting for one: the copy off the
laptop is JP-150's.
"""
from __future__ import annotations

import datetime
import gzip
import json
import os
import re
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path
from typing import List, Optional

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from ledger import _repo  # noqa: E402,F401

DAILY_KEPT = 14
WEEKLY_KEPT = 8
NAME = re.compile(r"^ledger-(\d{4}-\d{2}-\d{2})\.db\.gz$")


class CorruptCopy(Exception):
    """The copy failed its integrity check and was removed."""


def gzip_file(source: Path, dest: Path) -> None:
    """Compress source to dest, replacing dest in one step, readable by Josh only."""
    tmp = dest.with_name(dest.name + ".tmp")
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as raw, gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as z, \
            source.open("rb") as src:
        shutil.copyfileobj(src, z)
    os.replace(str(tmp), str(dest))


def _integrity(copy: sqlite3.Connection) -> list:
    return copy.execute("PRAGMA integrity_check").fetchall()


def copy_to(conn: sqlite3.Connection, dest: Path) -> None:
    """Copy the database `conn` is open on to `dest` (a .gz file). Raises CorruptCopy, leaving nothing, if the copy
    does not pass PRAGMA integrity_check."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="ledger-copy-", dir=str(dest.parent)))
    try:
        plain = work / "copy.db"
        target = sqlite3.connect(str(plain))
        try:
            conn.backup(target)
            verdict = _integrity(target)
        finally:
            target.close()
        if verdict != [("ok",)]:
            raise CorruptCopy("integrity check failed: {}".format(verdict[:1]))
        gzip_file(plain, dest)
    finally:
        shutil.rmtree(str(work), ignore_errors=True)


def rotate(folder: Path, today: datetime.date) -> List[Path]:
    """Remove all but the newest 14 daily copies and the newest copy of each of the last 8 weeks (counted back from
    today). Only files named ledger-<date>.db.gz are looked at. Returns what was removed."""
    copies = []
    for p in folder.iterdir() if folder.is_dir() else []:
        m = NAME.match(p.name)
        if m:
            try:
                copies.append((datetime.date.fromisoformat(m.group(1)), p))
            except ValueError:
                continue
    copies.sort(key=lambda c: c[0], reverse=True)
    keep = {p for _, p in copies[:DAILY_KEPT]}
    seen_weeks = set()
    for day, p in copies:  # newest first, so the first copy of a week is its newest
        week = (today - day).days // 7
        if 0 <= week < WEEKLY_KEPT and week not in seen_weeks:
            seen_weeks.add(week)
            keep.add(p)
    removed = [p for _, p in copies if p not in keep]
    for p in removed:
        p.unlink()
    return removed


def main() -> int:
    from laptop import common
    from ledger import db
    path = db.ledger_path()
    if not path.is_file():
        print("backup: there is no ledger at {}".format(path), file=sys.stderr)
        return 1
    now = common.now_utc()
    dest = db.backups_dir() / "ledger-{}.db.gz".format(now[:10])
    conn = db.connect(path)
    try:
        copy_to(conn, dest)
    except CorruptCopy as e:
        print("backup: {}".format(e), file=sys.stderr)
        return 1
    finally:
        conn.close()
    removed = rotate(db.backups_dir(), datetime.date.fromisoformat(now[:10]))
    print(json.dumps({"backup": dest.name, "removed": len(removed)}, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
