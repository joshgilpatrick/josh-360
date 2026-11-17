"""Database and evidence checks (JP-152): ledger.db and cache.db exist, are at the right schema version and hold
what the code expects; the daily backups are being made; and the real-use evidence the proofs ask Josh to look for.
Every database is opened read-only, and only counts and names are read: never a row's text. Sources: JP-107, JP-108,
JP-110, JP-111, JP-112, JP-118."""
from __future__ import annotations

import datetime
import re
import sqlite3
import sys
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple

sys.dont_write_bytecode = True
from .core import FAIL, PASS, SKIP, WARN, Ctx, Result, check  # noqa: E402
from .install_checks import ago, ledger_count  # noqa: E402

MIGRATION = re.compile(r"^(\d{4})-[a-z0-9][a-z0-9-]*\.sql$")
BACKUP_FRESH_SECONDS = 36 * 3600
INSTALL_FIX = "python3 ~/.josh-360/repo/laptop/install.py (or: doctor --fix)"


def header_version(path: Path) -> int:
    with path.open("rb") as f:
        head = f.read(100)
    if len(head) < 100 or not head.startswith(b"SQLite format 3\x00"):
        raise ValueError("not a SQLite database")
    return int.from_bytes(head[60:64], "big")


def newest_version(copy: Path) -> int:
    folder = copy / "ledger" / "migrations"
    found = [int(m.group(1)) for m in (MIGRATION.match(p.name) for p in folder.glob("*.sql")) if m]
    return max([1] + found)


def reference_names(copy: Path) -> Tuple[Set[str], Set[str]]:
    """The tables and triggers a correct ledger has: schema.sql plus every migration, built in memory."""
    conn = sqlite3.connect(":memory:")
    try:
        conn.executescript((copy / "ledger" / "schema.sql").read_text(encoding="utf-8"))
        for p in sorted((copy / "ledger" / "migrations").glob("*.sql")):
            m = MIGRATION.match(p.name)
            if m and int(m.group(1)) > 1:
                conn.executescript("BEGIN;\n" + p.read_text(encoding="utf-8") + "\nCOMMIT;\n")
        return _names(conn)
    finally:
        conn.close()


def _names(conn: sqlite3.Connection) -> Tuple[Set[str], Set[str]]:
    rows = conn.execute("SELECT type, name FROM sqlite_master WHERE type IN ('table', 'trigger')").fetchall()
    return ({n for t, n in rows if t == "table" and not n.startswith("sqlite_")}, {n for t, n in rows if t == "trigger"})


@check("data", "ledger")
def ledger_db(ctx: Ctx) -> Result:
    cid = "data.ledger"
    path = ctx.state / "ledger.db"
    if not path.is_file():
        return Result(cid, FAIL, "{} does not exist".format(ctx.tilde(path)), INSTALL_FIX, "install")
    try:
        have = header_version(path)
        want = newest_version(ctx.copy)
        conn = ctx.sqlite_ro(path)
        try:
            quick = conn.execute("PRAGMA quick_check(1)").fetchone()[0]
        finally:
            conn.close()
    except (OSError, ValueError, sqlite3.Error) as e:
        return Result(cid, FAIL, "{} cannot be read ({})".format(ctx.tilde(path), e.__class__.__name__),
                      "restore the newest copy from ~/.josh-360/backups (gunzip it into place), then rerun the doctor")
    if quick != "ok":
        return Result(cid, FAIL, "the ledger's integrity check says: {}".format(str(quick)[:80]),
                      "restore the newest copy from ~/.josh-360/backups (gunzip it into place)")
    if have < want:
        return Result(cid, FAIL, "schema version {} is behind the code's {}".format(have, want), INSTALL_FIX, "install")
    if have > want:
        return Result(cid, WARN, "schema version {} is newer than the laptop copy's {}".format(have, want),
                      "the copy is behind main: python3 ~/.josh-360/repo/laptop/follow.py")
    return Result(cid, PASS, "schema version {} (current), integrity ok".format(have))


@check("data", "ledger-shape")
def ledger_shape(ctx: Ctx) -> Result:
    cid = "data.ledger-shape"
    path = ctx.state / "ledger.db"
    if not path.is_file():
        return Result(cid, SKIP, "there is no ledger to compare")
    try:
        want_tables, want_triggers = reference_names(ctx.copy)
        conn = ctx.sqlite_ro(path)
        try:
            tables, triggers = _names(conn)
        finally:
            conn.close()
    except (OSError, sqlite3.Error) as e:
        return Result(cid, WARN, "could not compare the ledger with schema.sql ({})".format(e.__class__.__name__),
                      "check data.ledger first")
    lost_tables, lost_triggers = sorted(want_tables - tables), sorted(want_triggers - triggers)
    if lost_tables or lost_triggers:
        what = "tables " + ", ".join(lost_tables[:5]) if lost_tables else ""
        what += ("; " if what else "") + ("triggers " + ", ".join(lost_triggers[:5]) if lost_triggers else "")
        return Result(cid, FAIL, "the ledger is missing {}: it is no longer append-only".format(what),
                      "restore the newest copy from ~/.josh-360/backups, or ask a cloud session for a repair migration")
    return Result(cid, PASS, "all {} tables and {} triggers from schema.sql are there".format(len(want_tables), len(want_triggers)))


@check("data", "recursive-triggers")
def recursive_triggers(ctx: Ctx) -> Result:
    """recursive_triggers is a setting of each connection, not of the file. Without it INSERT OR REPLACE would delete a
    ledger row past its no_delete trigger. Two proofs: the code turns it on, and this SQLite honours it."""
    cid = "data.recursive-triggers"
    db_py = ctx.copy / "ledger" / "db.py"
    try:
        source = db_py.read_text(encoding="utf-8")
    except OSError:
        return Result(cid, FAIL, "{} cannot be read".format(ctx.tilde(db_py)), "python3 ~/.josh-360/repo/laptop/follow.py")
    if not re.search(r"PRAGMA\s+recursive_triggers\s*=\s*ON", source):
        return Result(cid, FAIL, "ledger/db.py no longer turns recursive_triggers on", "report it: the ledger could lose rows")
    conn = sqlite3.connect(":memory:")
    try:
        conn.executescript("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t VALUES (1, 'a');"
                           "CREATE TRIGGER t_no_delete BEFORE DELETE ON t BEGIN SELECT RAISE(ABORT, 'no'); END;")
        conn.execute("PRAGMA recursive_triggers = ON")
        try:
            conn.execute("INSERT OR REPLACE INTO t VALUES (1, 'b')")
            blocked = False
        except sqlite3.DatabaseError:
            blocked = True
    finally:
        conn.close()
    if not blocked:
        return Result(cid, FAIL, "this SQLite ({}) does not stop INSERT OR REPLACE at a delete trigger".format(
            sqlite3.sqlite_version), "use /usr/bin/python3, whose SQLite is new enough")
    return Result(cid, PASS, "ledger/db.py sets it on every connection and SQLite {} honours it".format(sqlite3.sqlite_version))


@check("data", "cache-db")
def cache_db(ctx: Ctx) -> Result:
    cid = "data.cache-db"
    path = ctx.state / "cache.db"
    if not path.is_file():
        return Result(cid, WARN, "{} does not exist yet; the headless Session Atlas creates it".format(ctx.tilde(path)),
                      "check backfills.retire-session-atlas and services.atlas-launchd")
    try:
        conn = ctx.sqlite_ro(path)
        try:
            version = conn.execute("PRAGMA user_version").fetchone()[0]
            tables = [n for (n,) in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")]
            quick = conn.execute("PRAGMA quick_check(1)").fetchone()[0]
        finally:
            conn.close()
    except sqlite3.Error as e:
        return Result(cid, FAIL, "{} cannot be read ({})".format(ctx.tilde(path), e.__class__.__name__),
                      "cache.db is rebuildable: move it aside and let the Atlas service recreate it")
    if quick != "ok" or not tables:
        return Result(cid, FAIL, "cache.db {}".format("failed its integrity check" if quick != "ok" else "has no tables"),
                      "cache.db is rebuildable: move it aside and let the Atlas service recreate it")
    return Result(cid, PASS, "{} tables, user_version {}, integrity ok".format(len(tables), version))


@check("data", "backups")
def ledger_backups(ctx: Ctx) -> Result:
    cid = "data.backups"
    folder = ctx.home / "backups"
    files = sorted(folder.glob("ledger-*.db.gz")) if folder.is_dir() else []
    if not files:
        return Result(cid, WARN, "no daily ledger backup exists yet in {}".format(ctx.tilde(folder)),
                      "the ledger-backup job runs daily; or: python3 ~/.josh-360/repo/ledger/backup.py")
    newest = max(p.stat().st_mtime for p in files)
    age = ctx.age_seconds(newest)
    if age > BACKUP_FRESH_SECONDS:
        return Result(cid, FAIL, "the newest backup is {} old ({} kept)".format(ago(age)[:-4], len(files)),
                      "read ~/.josh-360/logs/ledger-backup.log")
    return Result(cid, PASS, "{} backups kept, newest made {}".format(len(files), ago(age)))


@check("data", "ledger-content")
def ledger_content(ctx: Ctx) -> Result:
    cid = "data.ledger-content"
    sessions, episodes = ledger_count(ctx, "sessions"), ledger_count(ctx, "session_episodes")
    if sessions < 0:
        return Result(cid, SKIP, "the ledger cannot be read (see data.ledger)")
    if sessions == 0:
        return Result(cid, WARN, "the ledger holds no sessions: the recorder has recorded nothing",
                      "check jobs.ledger-record and the SessionStart hook (hooks.ledger-spool); read ~/.josh-360/logs/ledger-record.log")
    return Result(cid, PASS, "{} sessions and {} episodes recorded".format(sessions, episodes))


def _evidence(ctx: Ctx, cid: str, table: str, what: str, how: str) -> Result:
    n = ledger_count(ctx, table)
    if n < 0:
        return Result(cid, SKIP, "the ledger cannot be read (see data.ledger)")
    if n == 0:
        return Result(cid, WARN, "no {} yet in the ledger ({})".format(what, table), how)
    return Result(cid, PASS, "{} {} recorded".format(n, what))


@check("evidence", "ticket-offer")
def ev_ticket_offer(ctx: Ctx) -> Result:
    return _evidence(ctx, "evidence.ticket-offer", "ticket_offers", "ticket offers (JP-110)",
                     "not yet seen: the manual check is in the list below (start a session in a throwaway folder, commit)")


@check("evidence", "ticket-comments")
def ev_comments(ctx: Ctx) -> Result:
    return _evidence(ctx, "evidence.ticket-comments", "comment_deliveries", "ticket comment deliveries (JP-118)",
                     "not yet seen: the manual check is in the list below (comment on a ticket a session is working on)")


@check("evidence", "summaries")
def ev_summaries(ctx: Ctx) -> Result:
    return _evidence(ctx, "evidence.summaries", "session_summaries", "session summaries (JP-108)",
                     "read ~/.josh-360/logs/ledger-summary.log (is `claude` found?)")


@check("evidence", "friction")
def ev_friction(ctx: Ctx) -> Result:
    return _evidence(ctx, "evidence.friction", "session_facts", "friction facts (JP-112)",
                     "check backfills.ledger-friction-catchup")


@check("evidence", "debriefs")
def ev_debriefs(ctx: Ctx) -> Result:
    # A debrief needs friction or a graph run, so none for a day or two is normal: SKIP, not WARN.
    n = ledger_count(ctx, "debriefs")
    if n < 0:
        return Result("evidence.debriefs", SKIP, "the ledger cannot be read (see data.ledger)")
    if n == 0:
        return Result("evidence.debriefs", SKIP, "no debriefs yet (JP-113); expected after a day or two of sessions with friction")
    return Result("evidence.debriefs", PASS, "{} debriefs recorded".format(n))
