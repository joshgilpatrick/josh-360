"""Overwrite patient data found in one cell of the ledger (JP-107, Task 8). Josh runs this, at a terminal.

    python3 ledger/redact.py --table <table> --row <id> --column <column>

The ledger is append-only, so withdrawing a row leaves its text in the file. If patient data ever reaches one of the
twelve free-text columns, this replaces that one cell with `withheld: patient data`, in one transaction that drops
and puts back that table's update trigger, and adds a `redactions` row saying where (never what). Then it does the
same to every backup that holds the row, on the laptop and in the Azure container (ledger/upload.py). This is a
permanent change, so it asks Josh to type `redact` first and refuses to run when its input is not a terminal. Exit 0
done, 2 refused or bad input, 3 done except for the uploaded copies, which the next upload run finishes (JP-150).
Python 3.9, standard library only.
"""
from __future__ import annotations

import argparse
import gzip
import json
import os
import re
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path
from typing import List, Optional, TextIO

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from ledger import _repo  # noqa: E402,F401
from ledger import azure_blob, backup, db, upload  # noqa: E402
from ledger.text import CAPS, WITHHELD  # noqa: E402

BY = "ledger/redact.py"
IDENT = re.compile(r"^[a-z_][a-z0-9_]*$")


def _overwrite(conn: sqlite3.Connection, table: str, row_id: int, column: str) -> bool:
    """The trigger-drop, update and trigger-restore for one cell, in the caller's open transaction. False when the
    row does not exist."""
    if (table, column) not in CAPS or not IDENT.match(table) or not IDENT.match(column):
        raise ValueError("{}.{} is not one of the free-text columns".format(table, column))
    name = table + "_no_update"
    sql = conn.execute("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?", (name,)).fetchone()
    if sql is None:
        raise ValueError("table {} has no {} trigger".format(table, name))
    if conn.execute("SELECT 1 FROM {} WHERE id = ?".format(table), (row_id,)).fetchone() is None:
        return False
    conn.execute("DROP TRIGGER {}".format(name))
    conn.execute("UPDATE {} SET {} = ? WHERE id = ?".format(table, column), (WITHHELD, row_id))
    conn.execute(sql[0])
    return True


def redact(conn: sqlite3.Connection, table: str, row_id: int, column: str, now: str) -> int:
    """Redact one cell and record that it happened. Returns the `redactions` row id. ValueError if the column is not
    a free-text column or the row is not there; nothing changes then."""
    conn.execute("PRAGMA secure_delete = ON")  # freed bytes are zeroed, so the old text does not linger in the file
    with db.transaction(conn):
        if not _overwrite(conn, table, row_id, column):
            raise ValueError("there is no row {} in {}".format(row_id, table))
        cur = conn.execute("INSERT INTO redactions (table_name, row_id, column_name, redacted_at, redacted_by, "
                           "recorded_by) VALUES (?, ?, ?, ?, 'josh', ?)", (table, row_id, column, now, BY))
        redaction_id = cur.lastrowid
    conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    return redaction_id


def redact_gz(gz: Path, table: str, row_id: int, column: str, work_dir: Path) -> bool:
    """Redact the same cell in one backup (a .gz file), rewriting it in place. True when the row was there and the
    file was rewritten, False when it was not. ValueError when the backup lacks the table; sqlite3.Error or OSError
    when it cannot be read. `work_dir` is where the unzipped copy lives while it is changed (it is removed)."""
    work = Path(tempfile.mkdtemp(prefix="ledger-redact-", dir=str(work_dir)))
    try:
        plain = work / "copy.db"
        with gzip.open(str(gz), "rb") as src, plain.open("wb") as out:
            shutil.copyfileobj(src, out)
        conn = sqlite3.connect(str(plain), isolation_level=None)
        try:
            conn.execute("PRAGMA secure_delete = ON")
            conn.execute("BEGIN IMMEDIATE")
            try:
                changed = _overwrite(conn, table, row_id, column)
                conn.execute("COMMIT")
            except BaseException:
                conn.execute("ROLLBACK")
                raise
            if changed:
                conn.execute("VACUUM")
        finally:
            conn.close()
        if changed:
            backup.gzip_file(plain, gz)
        return changed
    finally:
        shutil.rmtree(str(work), ignore_errors=True)


def redact_backups(folder: Path, table: str, row_id: int, column: str) -> int:
    """Redact the same cell in every backup (ledger-*.db.gz) that holds the row. Returns how many were rewritten."""
    rewritten = 0
    for gz in sorted(folder.glob("*.db.gz")) if folder.is_dir() else []:
        try:
            rewritten += redact_gz(gz, table, row_id, column, folder)
        except (sqlite3.Error, ValueError, OSError):
            continue  # a backup that cannot be read or lacks the table is left as it is
    return rewritten


def redact_uploads(client, table: str, row_id: int, column: str) -> dict:
    """The same overwrite in the uploaded copies (JP-150). `client` None means the container named in the settings;
    with none named there is nothing uploaded and nothing to do. When the container cannot be reached, or a copy
    cannot be read, the location is kept for the next upload run (`upload.queue_redaction`) and `pending` is true."""
    from laptop import common
    if client is None:
        try:
            config = azure_blob.load_config(common.state_dir(), os.environ)
        except azure_blob.AzureError as e:
            upload.queue_redaction(table, row_id, column)
            return {"pending": True, "error": str(e)}
        if config is None:
            return {"pending": False, "rewritten": None}
        client = azure_blob.AzCli(*config)
    try:
        result = upload.redact_uploaded(client, table, row_id, column)
    except azure_blob.AzureError as e:
        upload.queue_redaction(table, row_id, column)
        return {"pending": True, "error": str(e)}
    if result["unreadable"]:
        upload.queue_redaction(table, row_id, column)
        return {"pending": True, "rewritten": result["rewritten"],
                "error": "could not read: " + ", ".join(result["unreadable"])}
    return {"pending": False, "rewritten": result["rewritten"]}


def main(argv: Optional[List[str]] = None, stdin: Optional[TextIO] = None, path: Optional[Path] = None,
         backups: Optional[Path] = None, client=None) -> int:
    stdin = stdin or sys.stdin
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--table", required=True)
    parser.add_argument("--row", required=True, type=int)
    parser.add_argument("--column", required=True)
    args = parser.parse_args(argv)
    if (args.table, args.column) not in CAPS:
        print("redact: {}.{} is not one of the free-text columns".format(args.table, args.column), file=sys.stderr)
        return 2
    path = path or db.ledger_path()
    if not path.is_file():
        print("redact: there is no ledger at {}".format(path), file=sys.stderr)
        return 2
    if not stdin.isatty():
        print("redact: this must be run by Josh at a terminal", file=sys.stderr)
        return 2
    print("This permanently overwrites {}.{} of row {} and every backup of it. Type redact to go on: ".format(
        args.table, args.column, args.row), end="", file=sys.stderr, flush=True)
    if stdin.readline().strip() != "redact":
        print("redact: not confirmed, nothing changed", file=sys.stderr)
        return 2
    from laptop import common
    conn = db.connect_existing(path)
    try:
        redaction_id = redact(conn, args.table, args.row, args.column, common.now_utc())
    except ValueError as e:
        print("redact: {}".format(e), file=sys.stderr)
        return 2
    finally:
        conn.close()
    rewritten = redact_backups(backups or db.backups_dir(), args.table, args.row, args.column)
    uploaded = redact_uploads(client, args.table, args.row, args.column)
    summary = {"redaction": redaction_id, "backups_rewritten": rewritten, "uploaded_rewritten": uploaded.get("rewritten")}
    if uploaded["pending"]:
        summary["uploaded_copies_still_to_do"] = uploaded["error"]
    print(json.dumps(summary, sort_keys=True))
    if uploaded["pending"]:
        print("redact: the ledger and the local backups are done, but the uploaded copies are not: {}. The next "
              "upload run does them; check reports/ledger-upload.json on laptop-status.".format(uploaded["error"]),
              file=sys.stderr)
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
