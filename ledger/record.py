"""The recorder: turns the spool, transcripts and git into ledger rows (JP-107, Task 5). Python 3.9, stdlib only.

Run by the `ledger-record` job every five minutes. It never calls a model and opens no network connection of its own:
the one network read (a ticket's epic in Jira) is the injected `jira` callable.

  - A `SessionStart` spool line writes the session's `sessions` row at once, so rows written while the session still
    runs (step runs, asks, ticket links) have something to point at.
  - A session has "gone quiet" when its `SessionEnd` fired or its transcript has not grown for 30 minutes. Then, and
    only then, the episode is written: its times, folder, branch, title, turns, refs, ticket link and home.
  - A `TicketOffer` spool line (JP-110) writes a `ticket_offers` row, and for a yes a `ticket_links` row (ledger/offer.py).
  - A resumed session that goes quiet again gets the next episode. Rows already written are never touched.
  - Each session is written in its own transaction, so one bad session never stops the others.
  - A session whose folder is inside a `.phi` folder stores no title. Any other title is stored after the screen.

    python3 ledger/record.py    one pass over the real spool and transcripts; prints the counts
"""
from __future__ import annotations

import calendar
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Callable, Dict, List, Optional, Tuple

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from ledger import _repo  # noqa: E402,F401
from laptop import common  # noqa: E402
from ledger import costs, db, homes, offer, sessions, spool, state_notes, transcript  # noqa: E402
from ledger.text import short_text  # noqa: E402

BY = "ledger/record.py"
QUIET_AFTER_SECONDS = 1800
DISCOVER_DAYS = 14  # transcripts older than this are the backfill's job, not the recorder's
GIT_TIMEOUT = 10
REMOTE = re.compile(r"[:/]([^/:]+)/([^/]+?)(?:\.git)?/?$")

GitRun = Callable[[str, List[str]], Optional[str]]  # (folder, git args) -> stdout, or None when git failed


def _epoch(stamp: str) -> int:
    return calendar.timegm(time.strptime(stamp, "%Y-%m-%dT%H:%M:%SZ"))


def _stamp(epoch: int) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch))


def _log(message: str) -> None:
    try:
        common.logs_dir().mkdir(parents=True, exist_ok=True)
        with (common.logs_dir() / "ledger-record.log").open("a", encoding="utf-8") as f:
            f.write("{} {}\n".format(common.now_utc(), message))
    except OSError:
        pass


def real_git(folder: str, args: List[str]) -> Optional[str]:
    if not folder or not os.path.isdir(folder):
        return None
    try:
        out = subprocess.run(["git", "-c", "core.hooksPath=/dev/null"] + args, cwd=folder, timeout=GIT_TIMEOUT,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
    except (OSError, subprocess.SubprocessError):
        return None
    return out.stdout.strip() if out.returncode == 0 else None


def _git_facts(git: GitRun, folder: Optional[str], branch: Optional[str], began: str, quiet: str) -> Dict[str, object]:
    """git_root, repo and the commits made on the branch during the episode. A failed call leaves its field empty."""
    facts: Dict[str, object] = {"git_root": None, "repo": None, "commits": []}
    if not folder:
        return facts
    root = git(folder, ["rev-parse", "--show-toplevel"])
    if root is None:
        _log("git unavailable for a session folder; git_root, repo and commits left empty")
        return facts
    facts["git_root"] = root or None
    remote = git(folder, ["remote", "get-url", "origin"])
    match = REMOTE.search(remote) if remote else None
    if match:
        facts["repo"] = "{}/{}".format(match.group(1), match.group(2))
    if branch:
        log = git(folder, ["log", "--since=" + began, "--until=" + quiet, "--format=%H", branch])
        if log:
            facts["commits"] = [c for c in log.split() if re.match(r"^[0-9a-f]{7,64}$", c)]
    return facts


def _new_state() -> Dict[str, object]:
    return {"spool": {"file": "", "offset": 0}, "sessions": {}}


def _info(state: Dict[str, object], sid: str) -> Dict[str, object]:
    return state["sessions"].setdefault(sid, {})  # type: ignore[index,union-attr]


def _find_transcripts(projects: Path, now_epoch: int, days: Optional[int] = DISCOVER_DAYS) -> Dict[str, Path]:
    """tool_session_id -> transcript, for main sessions and subagents. A subagent's id is <parent>+<agent id>."""
    found: Dict[str, Path] = {}
    if not projects.is_dir():
        return found
    cutoff = now_epoch - days * 86400 if days is not None else None
    for path in list(projects.glob("*/*.jsonl")) + list(projects.glob("*/*/subagents/agent-*.jsonl")):
        try:
            if cutoff is not None and path.stat().st_mtime < cutoff:
                continue
        except OSError:
            continue
        sub = transcript.subagent_of(path)
        found[sub[0] + "+" + sub[1] if sub else path.stem] = path
    return found


def _ensure(conn, counts, *, sid, now, by, started_at, started_by, folder=None, transcript_path=None, entrypoint=None):
    before = conn.total_changes
    uid = sessions.ensure(conn, tool="claude-code", tool_session_id=sid, started_at=started_at, started_by=started_by,
                          now=now, by=by, start_folder=folder, transcript_path=transcript_path, entrypoint=entrypoint)
    if conn.total_changes > before:
        counts["sessions"] += 1
    return uid


def _read_spool(conn, state, spool_dir: Path, now: str, counts, registry: Optional[dict] = None) -> None:
    lines, new_mark = spool.read_since(spool_dir, state["spool"])
    for line in lines:
        sid = line.get("session_id")
        if not isinstance(sid, str) or not sid:
            continue
        if line.get("event") == offer.EVENT:  # the ticket offer and Josh's answer (JP-110)
            try:
                with db.transaction(conn):
                    counts["offers"] += offer.write_offer(conn, line, now, registry or {}, by=BY)
            except Exception as e:  # noqa: BLE001
                _log("could not write a ticket offer line: {}".format(type(e).__name__))
                counts["skipped"] += 1
            continue
        info = _info(state, sid)
        if line.get("transcript_path"):
            info["transcript"] = line["transcript_path"]
        if line.get("cwd"):
            info["cwd"] = line["cwd"]
        if line.get("event") == "SessionStart":
            info["ended_at"] = info["last_ended_at"] = None
            try:
                with db.transaction(conn):
                    _ensure(conn, counts, sid=sid, now=now, by=BY, started_at=line.get("at") or now,
                            started_by=line.get("started_by") or "unknown", folder=line.get("cwd"),
                            transcript_path=line.get("transcript_path"))
            except Exception as e:  # noqa: BLE001
                _log("could not write session start for {}: {}".format(sid, e))
                counts["skipped"] += 1
        elif line.get("event") == "SessionEnd":
            info["ended_at"] = line.get("at") or now
    state["spool"] = new_mark


def _next_episode(conn, uid: str) -> int:
    return conn.execute("SELECT COALESCE(MAX(episode), 0) + 1 FROM session_episodes WHERE session_uid = ?",
                        (uid,)).fetchone()[0]


def _lineage_root(conn, parent_uid: str) -> str:
    row = conn.execute("SELECT root_uid FROM session_lineage WHERE child_uid = ? ORDER BY id LIMIT 1",
                       (parent_uid,)).fetchone()
    return row[0] if row else parent_uid


def _record_session(conn, state, sid, path: Path, now: str, now_epoch: int, git: GitRun, jira, conv, counts,
                    cost_db=None, claude_home: Optional[Path] = None) -> None:
    info = _info(state, sid)
    size = path.stat().st_size
    uid_known = conn.execute("SELECT session_uid FROM sessions WHERE tool_session_id = ?", (sid,)).fetchone()
    have_episodes = bool(uid_known) and conn.execute(
        "SELECT 1 FROM session_episodes WHERE session_uid = ? LIMIT 1", (uid_known[0],)).fetchone() is not None
    if "offset" not in info:
        if have_episodes:  # the mark was lost: what is already recorded is not recorded twice
            info["offset"] = transcript.read_meta(path).end_offset
            return
        info["offset"] = 0
    if size <= info["offset"] and not info.get("ended_at"):
        return
    meta = transcript.read_meta(path, since_offset=info["offset"])
    sub = transcript.subagent_of(path)
    parent_sid = sub[0] if sub else None
    parent = _info(state, parent_sid) if parent_sid else {}
    ended_at = info.get("ended_at") or parent.get("ended_at") or parent.get("last_ended_at")
    stale = path.stat().st_mtime <= now_epoch - QUIET_AFTER_SECONDS
    if meta.lines_read == 0:
        info["offset"] = meta.end_offset
        info["ended_at"] = None
        return
    if not (ended_at or stale):
        return  # still working: nothing is written, and the next pass reads the same lines again

    write_episode(conn, sid, path, meta, ended_at=ended_at, cwd_hint=info.get("cwd"),
                  started_hint=info.get("started_at"), now=now, git=git, jira=jira, conv=conv, counts=counts,
                  cost_db=cost_db, claude_home=claude_home)
    counts["skipped"] += meta.skipped_lines
    info["offset"] = meta.end_offset
    info["last_ended_at"], info["ended_at"] = info.get("ended_at"), None  # a subagent read later still sees it


def write_episode(conn, sid: str, path: Path, meta, *, ended_at: Optional[str], now: str, git: GitRun, jira,
                  conv: dict, counts: Dict[str, int], cost_db=None, claude_home: Optional[Path] = None,
                  cwd_hint: Optional[str] = None, started_hint: Optional[str] = None, by: str = BY,
                  source: str = "transcript", title_hint=(None, None)) -> None:
    """Write one episode of one session, with its refs, ticket link, cost, notes, facts and home, in one
    transaction. The recorder calls it when a session goes quiet; the backfill calls it once per old transcript
    (source "backfill"). `title_hint` is a (title, source) another system holds, used when the transcript and the cost
    ledger have none. A session with no row yet gets one (started_by unknown, or its parent's for a subagent)."""
    sub = transcript.subagent_of(path)
    parent_sid = sub[0] if sub else None
    folder = meta.cwd or cwd_hint
    began = meta.first_at or started_hint or now
    last = meta.last_at or began
    quiet = ended_at if ended_at and ended_at >= last else _stamp(_epoch(last) + QUIET_AFTER_SECONDS)
    phi = not homes.keeps_words(folder)
    title, title_source = transcript.best_title(meta.titles)
    if title is None and title_source is None and cost_db is not None:  # the cost ledger may know a title
        title, title_source = costs.session_title(cost_db, sid)
    if title is None and title_source is None:
        title, title_source = title_hint
    if title is not None:
        title, withheld = short_text(title, 120, phi=phi)
        if withheld or title is None:
            title, title_source = None, "withheld"
    elif phi:
        title_source = "withheld"
    facts = _git_facts(git, folder, meta.branch, began, quiet)
    started_by = "unknown"
    row = conn.execute("SELECT session_uid, started_by FROM sessions WHERE tool_session_id = ?", (sid,)).fetchone()

    with db.transaction(conn):
        parent_uid = None
        if parent_sid:
            parent_row = conn.execute("SELECT session_uid, started_by FROM sessions WHERE tool_session_id = ?",
                                      (parent_sid,)).fetchone()
            parent_uid = parent_row[0] if parent_row else _ensure(
                conn, counts, sid=parent_sid, now=now, by=by, started_at=began, started_by="unknown")
            started_by = parent_row[1] if parent_row else "unknown"
        uid = row[0] if row else _ensure(conn, counts, sid=sid, now=now, by=by, started_at=began,
                                         started_by=started_by, folder=folder, transcript_path=str(path))
        if parent_uid:
            exists = conn.execute("SELECT 1 FROM session_lineage WHERE child_uid = ?", (uid,)).fetchone()
            if not exists:
                conn.execute(
                    "INSERT INTO session_lineage (child_uid, parent_uid, root_uid, kind, confidence, discovered_at, "
                    "recorded_by) VALUES (?, ?, ?, 'subagent', 'confirmed', ?, ?)",
                    (uid, parent_uid, _lineage_root(conn, parent_uid), now, by))
        episode = _next_episode(conn, uid)
        conn.execute(
            "INSERT INTO session_episodes (session_uid, episode, began_at, last_activity_at, quiet_at, end_reason, "
            "folder, git_root, repo, branch, worktree_path, title, title_source, turns, version, recorded_at, "
            "recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)",
            (uid, episode, began, last, quiet, "session-end" if ended_at else "quiet", folder, facts["git_root"],
             facts["repo"], meta.branch, meta.worktree, title, title_source, meta.turns, now, by))
        counts["episodes"] += 1
        counts["refs"] += _write_refs(conn, uid, episode, meta, folder, facts, began, now, source, by)
        if meta.branch and homes.TICKET_BRANCH.match(meta.branch):
            _link_ticket(conn, uid, meta.branch, conv, now, by)
        counts["costs"] += costs.copy_costs(conn, cost_db, uid, sid, now)
        counts["refs"] += costs.copy_links(conn, cost_db, uid, sid, episode, now, by=by, source=source)
        if not sub:  # STATE.md belongs to a main session
            wrote = state_notes.copy_notes(conn, state_notes.state_file(sid, claude_home), uid, episode,
                                           not phi, now)
            counts["notes"] += wrote
            for kind, fact in (("u-turn", "u_turns"), ("dead-end", "dead_ends")):
                _fact(conn, uid, episode, fact, conn.execute(
                    "SELECT COUNT(*) FROM session_state_notes WHERE session_uid = ? AND episode = ? AND kind = ?",
                    (uid, episode, kind)).fetchone()[0], now, by)
        _fact(conn, uid, episode, "compactions", meta.compactions, now, by)
        ep = {"episode": episode, "folder": folder, "repo": facts["repo"], "branch": meta.branch}
        if homes.write_home_if_changed(conn, homes.find_home(uid, ep, conn, conv, jira), now):
            counts["homes"] += 1


def _write_refs(conn, uid, episode, meta, folder, facts, observed, now, source="transcript", by=BY) -> int:
    repo = facts["repo"] or ""
    wanted = []
    if folder:
        wanted.append(("folder", "", folder, source))
    if meta.branch:
        wanted.append(("branch", repo, meta.branch, source))
    if meta.worktree:
        wanted.append(("worktree", "", meta.worktree, source))
    wanted += [("file", "", made, source) for made in meta.files_created]
    wanted += [("pr", pr_repo, url, source) for url, pr_repo in meta.pr_urls]
    wanted += [("commit", repo, sha, "git") for sha in facts["commits"]]
    added = 0
    for kind, ref_repo, value, ref_source in wanted:
        before = conn.total_changes
        conn.execute(
            "INSERT OR IGNORE INTO session_refs (session_uid, episode, kind, repo, value, source, observed_at, "
            "recorded_at, recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (uid, episode, kind, ref_repo, value, ref_source, observed, now, by))
        added += conn.total_changes - before
    return added


def _fact(conn, uid: str, episode: int, fact: str, value: int, now: str, by: str = BY) -> None:
    """A friction fact for the episode, when it is above zero and not already written."""
    if value > 0 and not conn.execute("SELECT 1 FROM session_facts WHERE session_uid = ? AND episode = ? AND fact = ?",
                                      (uid, episode, fact)).fetchone():
        conn.execute("INSERT INTO session_facts (session_uid, episode, fact, value, recorded_at, recorded_by) "
                     "VALUES (?, ?, ?, ?, ?, ?)", (uid, episode, fact, value, now, by))


def _link_ticket(conn, uid: str, branch: str, conv: dict, now: str, by: str = BY) -> None:
    key = homes.TICKET_BRANCH.match(branch).group(1)
    tracker = homes._tracker_for(key, conv["registry"])
    if tracker is None:
        return
    exists = conn.execute("SELECT 1 FROM ticket_links WHERE session_uid = ? AND ticket_key = ? AND source = 'branch'",
                          (uid, key)).fetchone()
    if not exists:
        conn.execute("INSERT INTO ticket_links (session_uid, tracker, ticket_key, relation, source, linked_at, "
                     "recorded_by) VALUES (?, ?, ?, 'touched', 'branch', ?, ?)", (uid, tracker, key, now, by))


def record_pass(conn, *, now: str, spool: Path, projects: Path, git: GitRun, jira: Callable, conventions: dict,
                state: Optional[Dict[str, object]] = None, cost_db=None,
                claude_home: Optional[Path] = None) -> Dict[str, int]:
    """One pass. `state` holds the spool mark and each transcript's offset; pass the same dict to the next pass.
    `cost_db` is the cost ledger opened read-only (None when it is missing); `claude_home` is where STATE.md files
    are read from (default ~/.claude)."""
    state = state if state is not None else _new_state()
    counts = {"sessions": 0, "episodes": 0, "refs": 0, "homes": 0, "skipped": 0, "costs": 0, "notes": 0, "offers": 0}
    now_epoch = _epoch(now)
    _read_spool(conn, state, spool, now, counts, conventions.get("registry"))
    paths = _find_transcripts(projects, now_epoch)
    for sid, info in list(state["sessions"].items()):  # a transcript the spool named, wherever it is
        named = info.get("transcript")
        if named and sid not in paths and Path(named).is_file():
            paths[sid] = Path(named)
    # main sessions first, so a subagent's parent exists with its own starter before the child is written
    for sid in sorted(paths, key=lambda s: ("+" in s, s)):
        try:
            _record_session(conn, state, sid, paths[sid], now, now_epoch, git, jira, conventions, counts, cost_db,
                            claude_home)
        except Exception as e:  # noqa: BLE001  (one bad session never stops the others)
            _log("could not record {}: {}: {}".format(sid, type(e).__name__, e))
            counts["skipped"] += 1
    return counts


def rehome_recent(conn, now: str, jira: Callable, conventions: dict, days: int = 30,
                  only_failed: bool = False) -> Dict[str, int]:
    """Work out the home again for each session with an episode in the last `days` days; a row is written only when
    the answer changed (a ticket moved epic, the registry changed), or when a failed Jira read can now be repeated.
    only_failed limits it to homes written while Jira was down, which the job retries on every pass."""
    since = _stamp(_epoch(now) - days * 86400)
    rows = conn.execute(
        """SELECT e.session_uid, e.episode, e.folder, e.repo, e.branch FROM current_session_episodes e
           WHERE e.episode = (SELECT MAX(e2.episode) FROM current_session_episodes e2 WHERE e2.session_uid = e.session_uid)
             AND e.quiet_at >= ?""", (since,)).fetchall()
    written = 0
    for uid, number, folder, repo, branch in rows:
        try:
            if only_failed:
                current = conn.execute("SELECT jira_read FROM current_homes WHERE session_uid = ?", (uid,)).fetchone()
                if not current or current[0] != "failed":
                    continue
            ep = {"episode": number, "folder": folder, "repo": repo, "branch": branch}
            with db.transaction(conn):
                if homes.write_home_if_changed(conn, homes.find_home(uid, ep, conn, conventions, jira), now):
                    written += 1
        except Exception as e:  # noqa: BLE001
            _log("could not re-home {}: {}: {}".format(uid, type(e).__name__, e))
    return {"homes": written}


def recopy_costs_recent(conn, cost_db, now: str, days: int = 30) -> Dict[str, int]:
    """Copy cost again for recent sessions, so a re-pricing or later usage adds a new batch."""
    since = _stamp(_epoch(now) - days * 86400)
    written = 0
    for uid, sid in conn.execute(
            """SELECT DISTINCT s.session_uid, s.tool_session_id FROM sessions s
               JOIN current_session_episodes e ON e.session_uid = s.session_uid WHERE e.quiet_at >= ?""",
            (since,)).fetchall():
        try:
            with db.transaction(conn):
                written += costs.copy_costs(conn, cost_db, uid, sid, now)
        except Exception as e:  # noqa: BLE001
            _log("could not re-copy cost for {}: {}: {}".format(uid, type(e).__name__, e))
    return {"costs": written}


def _conventions_version() -> str:
    try:
        out = common.git(["log", "-1", "--format=%h", "--", "conventions"], common.REPO_ROOT, check=False)
        return out.stdout.strip() or "unknown"
    except Exception:  # noqa: BLE001
        return "unknown"


def main() -> int:
    from ledger import jira_read
    mark_file = common.state_dir() / "ledger-record.json"
    state = common.read_json(mark_file, None) or _new_state()
    conv = homes.load_conventions(_conventions_version(), str(Path.home()))
    names = [s["name"] for s in conv["registry"].get("systems") or []]
    fetch = jira_read.make_fetch(os.environ)
    conn = db.connect_existing(db.ledger_path())
    cost_db = costs.open_cost_ledger(Path.home() / ".claude" / "cost-ledger" / "ledger.db")
    now = common.now_utc()
    jira = lambda key: jira_read.ticket_context(key, fetch, names)  # noqa: E731
    try:
        counts = record_pass(conn, now=now, spool=spool.spool_dir(), projects=Path.home() / ".claude" / "projects",
                             git=real_git, jira=jira, conventions=conv, state=state, cost_db=cost_db)
        daily = state.get("rehomed") != now[:10]
        if daily:  # once a day: the registry or a ticket's epic may have changed, and costs may have been re-priced
            counts["homes"] += rehome_recent(conn, now, jira, conv)["homes"]
            counts["costs"] += recopy_costs_recent(conn, cost_db, now)["costs"]
            state["rehomed"] = now[:10]
        else:  # every pass: homes written while Jira was down are repeated
            counts["homes"] += rehome_recent(conn, now, jira, conv, only_failed=True)["homes"]
    finally:
        conn.close()
        if cost_db is not None:
            cost_db.close()
    common.Lane().write_text(mark_file, common.dump_json(state))
    print(json.dumps(counts, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
