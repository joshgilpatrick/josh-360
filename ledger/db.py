"""Open, create and migrate the ledger (JP-107, Task 1). Python 3.9, standard library only.

The ledger is one SQLite file, ~/.josh-360/state/ledger.db, built from ledger/schema.sql and changed only by the
numbered files in ledger/migrations/. Every connection to it is opened by `connect`, which turns on the pragmas the
append-only rule needs. Without recursive_triggers, INSERT OR REPLACE would delete a row past its no_delete trigger.

    python3 ledger/db.py    create or migrate the ledger on this machine and print its version
"""
from __future__ import annotations

import re
import secrets
import sqlite3
import sys
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator, List, Tuple

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from ledger import _repo  # noqa: E402,F401  (puts the repo root and graphs/gates on sys.path)
from ledger import backup  # noqa: E402
from laptop import common  # noqa: E402

ROOT = _repo.ROOT
SCHEMA = ROOT / "ledger" / "schema.sql"
MIGRATIONS = ROOT / "ledger" / "migrations"
MACHINE_LABEL = "work laptop"  # the schema says never a person's name, so not the host name

MIGRATION_NAME = re.compile(r"^(\d{4})-([a-z0-9][a-z0-9-]*)\.sql$")
MACHINE_ID = re.compile(r"^m-[0-9a-f]{8}$")


def ledger_path() -> Path:
    return common.state_dir() / "ledger.db"


def backups_dir() -> Path:
    return common.home() / "backups"


def connect(path: Path) -> sqlite3.Connection:
    """The only way code opens ledger.db for writing. Autocommit: use `transaction` for a unit of work."""
    conn = sqlite3.connect(str(path), timeout=5.0, isolation_level=None)
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA recursive_triggers = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


def connect_existing(path: Path) -> sqlite3.Connection:
    """connect() for a command: a ledger that is not there is an error, never an empty file created by accident."""
    if not path.is_file():
        raise FileNotFoundError("there is no ledger at {} (the install step creates it)".format(path))
    return connect(path)


@contextmanager
def transaction(conn: sqlite3.Connection) -> Iterator[sqlite3.Connection]:
    """One unit of work: everything inside commits together or not at all."""
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    conn.execute("COMMIT")


def machine_id(conn: sqlite3.Connection) -> str:
    row = conn.execute("SELECT machine_id FROM machines ORDER BY id LIMIT 1").fetchone()
    if row is None:
        raise ValueError("the ledger has no machine row")
    return row[0]


def user_version(conn: sqlite3.Connection) -> int:
    return conn.execute("PRAGMA user_version").fetchone()[0]


def header_version(path: Path) -> int:
    """user_version read straight from the file header, so a check opens no connection and leaves no -wal or -shm
    file behind (the install step must change nothing when the ledger is current)."""
    with path.open("rb") as f:
        head = f.read(100)
    if len(head) < 100 or not head.startswith(b"SQLite format 3\x00"):
        raise ValueError("not a SQLite database")
    return int.from_bytes(head[60:64], "big")


def newest_version(migrations: Path = MIGRATIONS) -> int:
    """The version a fully migrated ledger has: 1, or the number of the newest migration file."""
    found = [int(m.group(1)) for m in (MIGRATION_NAME.match(p.name) for p in migrations.glob("*.sql")) if m]
    return max([1] + found)


def pending_migrations(current: int, migrations: Path = MIGRATIONS) -> List[Tuple[int, str, Path]]:
    out = []
    for p in sorted(migrations.glob("*.sql")):
        m = MIGRATION_NAME.match(p.name)
        if m is None:
            raise ValueError("migration file name must be NNNN-name.sql: {}".format(p.name))
        if int(m.group(1)) > current:
            out.append((int(m.group(1)), m.group(2), p))
    return out


# -- refusing a migration that rewrites rows ---------------------------------------------------------------------

_COMMENT = re.compile(r"--[^\n]*")
_TRIGGER = re.compile(r"CREATE\s+TRIGGER\b.*?\bEND\s*;", re.IGNORECASE | re.DOTALL)
_REWRITE = re.compile(
    r"(?:^|;)\s*(?:UPDATE\b|DELETE\b|DROP\b|REPLACE\b|INSERT\s+OR\s+REPLACE\b|ALTER\s+TABLE\s+\S+\s+(?:DROP|RENAME)\b)",
    re.IGNORECASE)
_NEW_TABLE = re.compile(r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)", re.IGNORECASE)


def check_migration(sql: str) -> None:
    """Raise ValueError unless the migration only adds (README in ledger/migrations/)."""
    bare = _COMMENT.sub("", sql)
    outside_triggers = _TRIGGER.sub(";", bare)
    hit = _REWRITE.search(outside_triggers)
    if hit:
        raise ValueError("a migration may only add; it contains: {}".format(hit.group(0).strip(" ;\n")[:40]))
    for table in _NEW_TABLE.findall(bare):
        for suffix in ("no_update", "no_delete"):
            if not re.search(r"CREATE\s+TRIGGER\s+{}_{}\b".format(re.escape(table), suffix), bare, re.IGNORECASE):
                raise ValueError("new table {} needs its trigger {}_{}".format(table, table, suffix))


def _create(path: Path, now: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = connect(path)
    try:
        conn.executescript(SCHEMA.read_text(encoding="utf-8"))
        id_file = path.parent / "machine-id"
        existing = id_file.read_text(encoding="utf-8").strip() if id_file.is_file() else ""
        mid = existing if MACHINE_ID.match(existing) else "m-" + secrets.token_hex(4)
        conn.execute("INSERT INTO machines (machine_id, label, created_at, recorded_by) VALUES (?, ?, ?, ?)",
                     (mid, MACHINE_LABEL, now, "ledger/db.py"))
        id_file.write_text(mid + "\n", encoding="utf-8")
    finally:
        conn.close()


def ensure(path: Path, backups: Path, now: str, migrations: Path = MIGRATIONS) -> int:
    """Create the ledger from schema.sql, or apply the migrations it has not had. Returns its version.

    A second call changes nothing. A migration is checked first (ValueError, nothing applied), the database is backed
    up once before the first one (not when this call has just built it), and each is applied in one transaction with its schema_migrations row.
    """
    created = not path.exists()
    if created:
        _create(path, now)
    conn = connect(path)
    try:
        current = user_version(conn)
        todo = pending_migrations(current, migrations)
        if not todo:
            return current
        for _, _, file in todo:  # refuse every file before touching the database
            check_migration(file.read_text(encoding="utf-8"))
        if not created:  # a ledger this call just built holds nothing worth a backup
            stamp = now.replace(":", "")
            backup.copy_to(conn, backups / "pre-migration-{}-{}.db.gz".format(current, stamp))
        for number, name, file in todo:
            sql = file.read_text(encoding="utf-8")
            script = "BEGIN;\n{}\nINSERT INTO schema_migrations (version, name, applied_at) VALUES ({}, '{}', '{}');\n" \
                     "PRAGMA user_version = {};\nCOMMIT;\n".format(sql, number, name, now, number)
            try:
                conn.executescript(script)
            except BaseException:
                if conn.in_transaction:
                    conn.execute("ROLLBACK")
                raise
        return user_version(conn)
    finally:
        conn.close()


def main() -> int:
    version = ensure(ledger_path(), backups_dir(), common.now_utc())
    print("ledger: version {}".format(version))
    return 0


if __name__ == "__main__":
    sys.exit(main())
