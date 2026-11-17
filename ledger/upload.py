"""Copy the ledger's daily backups to Azure blob storage (JP-150). Python 3.9, standard library only.

    python3 ledger/upload.py    make the container hold the same ledger-<date>.db.gz copies the laptop keeps

A job of its own (`ledger-upload` in jobs.yaml), so a failed upload never fails the local backup. Each run:

1. finishes any redaction still owed to the uploaded copies (see below);
2. uploads each local copy the container lacks, or holds at a different size;
3. removes container copies outside the retention the laptop uses (14 daily, 8 weekly: `backup.keep_names`).

It prints one JSON report, which the job runner puts on `laptop-status` as reports/ledger-upload.json: `status` is
`ok`, `failed` (the container cannot be reached, or an uploaded copy could not be redacted) or `not-configured`
(no account and container are set), plus `last_success` and counts. The exit code is 0 in all three so the report is
always published. The container is named in `~/.josh-360/state/azure-backup.json` (ledger/azure_blob.py); it signs in
as Josh through `az login`, and no secret is stored anywhere by this job.

Redaction: `ledger/redact.py` overwrites a cell in the ledger and the local copies. For the uploaded copies it
downloads each, overwrites the same cell, and uploads it back (`redact_uploaded`). If the container cannot be reached
then, the cell's location (table, row, column; never its text) waits in `state/azure-redactions-pending.json` and the
next run does it first.
"""
from __future__ import annotations

import datetime
import fcntl
import json
import os
import shutil
import sqlite3
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator, List, Optional

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from ledger import _repo  # noqa: E402,F401
from ledger import azure_blob, backup, db  # noqa: E402


def _state_dir() -> Path:
    from laptop import common
    return common.state_dir()


def pending_path() -> Path:
    return _state_dir() / "azure-redactions-pending.json"


def state_path() -> Path:
    return _state_dir() / "azure-upload.json"


def _write_private(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(json.dumps(data, sort_keys=True) + "\n")
    os.replace(str(tmp), str(path))


def _read_json(path: Path, default):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return default


def pending_redactions() -> List[list]:
    data = _read_json(pending_path(), [])
    return [list(item) for item in data if isinstance(item, list) and len(item) == 3]


@contextmanager
def _pending_lock() -> Iterator[None]:
    """Held only for a read-modify-write of the pending file, never across a network call, so `redact.py` waits
    milliseconds, not minutes, while an upload run is busy."""
    path = pending_path().with_name("azure-redactions-pending.lock")
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(str(path), "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def queue_redaction(table: str, row_id: int, column: str) -> None:
    """Remember that the uploaded copies still owe this redaction. Holds where, never what."""
    with _pending_lock():
        pending = pending_redactions()
        item = [table, row_id, column]
        if item not in pending:
            pending.append(item)
        _write_private(pending_path(), pending)


def _settle(done: List[list]) -> None:
    """Remove the finished items from the file as it is now, so a redaction queued while this run was working stays."""
    with _pending_lock():
        _write_private(pending_path(), [i for i in pending_redactions() if i not in done])


def sync(client, folder: Path, today: datetime.date) -> dict:
    """Bring the container in line with `folder`. AzureError if it cannot be reached; nothing is removed then."""
    remote = {n: s for n, s in client.list_blobs().items() if backup.NAME.match(n)}
    local = {p.name: p for p in folder.iterdir() if p.is_file() and backup.NAME.match(p.name)} \
        if folder.is_dir() else {}
    keep = backup.keep_names(set(remote) | set(local), today)
    uploaded = []
    for name in sorted(local):
        if name in keep and remote.get(name) != local[name].stat().st_size:
            client.upload(name, local[name])
            uploaded.append(name)
    removed = sorted(n for n in remote if n not in keep)
    for name in removed:
        client.delete(name)
    return {"uploaded": uploaded, "removed": removed}


def redact_uploaded(client, table: str, row_id: int, column: str) -> dict:
    """Overwrite the same cell in every uploaded copy that holds the row. Returns how many were rewritten and the
    names of copies that could not be read (those still hold what they held). AzureError if the container cannot be
    reached."""
    from ledger import redact
    rewritten, unreadable = 0, []
    for name in sorted(n for n in client.list_blobs() if backup.NAME.match(n)):
        work = Path(tempfile.mkdtemp(prefix="ledger-remote-"))
        try:
            gz = work / name
            client.download(name, gz)
            try:
                changed = redact.redact_gz(gz, table, row_id, column, work)
            except ValueError:
                continue  # this copy lacks the table: nothing to redact in it
            except (sqlite3.Error, OSError, EOFError):
                unreadable.append(name)
                continue
            if changed:
                client.upload(name, gz)
                rewritten += 1
        finally:
            shutil.rmtree(str(work), ignore_errors=True)
    return {"rewritten": rewritten, "unreadable": unreadable}


def apply_pending(client) -> List[str]:
    """Do every owed redaction. Returns the names of uploaded copies that could not be read; an item whose copies
    could not all be read stays owed. AzureError leaves everything owed (what was finished before it is settled). An
    item queued while this runs is never dropped: only the finished items are removed, from the file as it is at the
    end."""
    done, unreadable = [], []
    try:
        for item in pending_redactions():
            result = redact_uploaded(client, *item)
            if result["unreadable"]:
                unreadable.extend(n for n in result["unreadable"] if n not in unreadable)
            else:
                done.append(item)
    finally:
        _settle(done)
    return unreadable


def run(client, folder: Path, today: datetime.date, now: str) -> dict:
    """One pass. Always returns the report; never raises for an unreachable container."""
    last = _read_json(state_path(), {}).get("last_success")
    report = {"status": "ok", "error": None, "last_success": last, "uploaded": [], "removed": 0,
              "pending_redactions": 0}
    try:
        unreadable = apply_pending(client)
        result = sync(client, folder, today)
        report["uploaded"], report["removed"] = result["uploaded"], len(result["removed"])
        if unreadable:
            report["status"] = "failed"
            report["error"] = "uploaded copies that could not be read for a redaction: " + ", ".join(unreadable)
        else:
            report["last_success"] = now
            _write_private(state_path(), {"last_success": now})
    except azure_blob.AzureError as e:
        report["status"], report["error"] = "failed", str(e)
    report["pending_redactions"] = len(pending_redactions())
    return report


def main(argv: Optional[List[str]] = None, client=None, today: Optional[datetime.date] = None,
         now: Optional[str] = None, folder: Optional[Path] = None) -> int:
    from laptop import common
    now = now or common.now_utc()
    today = today or datetime.date.fromisoformat(now[:10])
    last = _read_json(state_path(), {}).get("last_success")
    if client is None:
        try:
            config = azure_blob.load_config(common.state_dir(), os.environ)
        except azure_blob.AzureError as e:
            print(json.dumps({"status": "failed", "error": str(e), "last_success": last, "uploaded": [],
                              "removed": 0, "pending_redactions": len(pending_redactions())}, sort_keys=True))
            return 0
        if config is None:
            print(json.dumps({"status": "not-configured", "error": None, "last_success": last, "uploaded": [],
                              "removed": 0, "pending_redactions": len(pending_redactions())}, sort_keys=True))
            return 0
        client = azure_blob.AzCli(*config)
    print(json.dumps(run(client, folder or db.backups_dir(), today, now), sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
