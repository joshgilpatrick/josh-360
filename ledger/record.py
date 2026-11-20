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
  - JP-181: a run stops starting new work once its time budget (BUDGET_SECONDS) is spent and leaves the rest for the
    next run, so it ends well inside the job's timeout and the jobs behind it keep their five-minute pace. Its progress
    mark is saved after every session that changed it, so even a run the job runner kills keeps what it did, and the
    once-a-day re-home keeps its place between runs. Each ticket is read from Jira at most once per run.

    python3 ledger/record.py                 one run over the real spool and transcripts; prints the counts
    python3 ledger/record.py --budget 60     the same with a different time budget, in seconds
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
from ledger import costs, db, friction, friction_write, homes, offer, sessions, spool, state_notes, transcript  # noqa: E402
from ledger.text import short_text  # noqa: E402

BY = "ledger/record.py"
QUIET_AFTER_SECONDS = 1800
DISCOVER_DAYS = 14  # transcripts older than this are the backfill's job, not the recorder's
GIT_TIMEOUT = 10
BUDGET_SECONDS = 150  # the job's timeout is 4 minutes (jobs.yaml); one Jira read can take 10 s, a session up to 30 s
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
        _friction(conn, uid, episode, path, meta, sub is not None, started_by_row(conn, uid), folder, claude_home,
                  now, by)
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


def started_by_row(conn, uid: str) -> Optional[str]:
    row = conn.execute("SELECT started_by FROM sessions WHERE session_uid = ?", (uid,)).fetchone()
    return row[0] if row else None


def _friction(conn, uid, episode, path: Path, meta, is_subagent: bool, started_by: Optional[str],
              folder: Optional[str], claude_home: Optional[Path], now: str, by: str) -> None:
    """The friction facts and usage of the episode (JP-112), from the transcript lines this episode covers. All or
    nothing for the episode's facts, and a failure here is logged and never stops the episode. The size of the
    instruction files is counted only when the caller names its claude home (the real recorder and the backfill do)."""
    conn.execute("SAVEPOINT friction")
    try:
        who = friction.who_for(started_by, is_subagent)
        facts = friction.read(path, who=who, start_offset=meta.start_offset, end_offset=meta.end_offset)
        files = friction.instruction_files(folder, claude_home) if claude_home is not None and not is_subagent else []
        friction_write.record_episode(conn, uid, episode, facts, now, instructions=files, by=by)
        conn.execute("RELEASE friction")
    except Exception as e:  # noqa: BLE001
        conn.execute("ROLLBACK TO friction")
        conn.execute("RELEASE friction")
        _log("friction facts skipped for episode {} of {}: {}: {}".format(episode, uid, type(e).__name__, e))


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
                state: Optional[Dict[str, object]] = None, cost_db=None, claude_home: Optional[Path] = None,
                out_of_time: Callable[[], bool] = lambda: False,
                save: Callable[[Dict[str, object]], None] = lambda state: None) -> Dict[str, int]:
    """One pass. `state` holds the spool mark and each transcript's offset; pass the same dict to the next pass.
    `cost_db` is the cost ledger opened read-only (None when it is missing); `claude_home` is where STATE.md files
    are read from (default ~/.claude) and where the size of the instruction files is counted (only when given).
    JP-181: no new session is started once `out_of_time()` says so (the rest waits for the next pass), and `save` is
    given the state after the spool is read and after every session whose mark moved."""
    state = state if state is not None else _new_state()
    counts = {"sessions": 0, "episodes": 0, "refs": 0, "homes": 0, "skipped": 0, "costs": 0, "notes": 0, "offers": 0}
    now_epoch = _epoch(now)
    _read_spool(conn, state, spool, now, counts, conventions.get("registry"))
    save(state)
    paths = _find_transcripts(projects, now_epoch)
    for sid, info in list(state["sessions"].items()):  # a transcript the spool named, wherever it is
        named = info.get("transcript")
        if named and sid not in paths and Path(named).is_file():
            paths[sid] = Path(named)
    # main sessions first, so a subagent's parent exists with its own starter before the child is written
    for sid in sorted(paths, key=lambda s: ("+" in s, s)):
        if out_of_time():
            break
        before = dict(_info(state, sid))
        try:
            _record_session(conn, state, sid, paths[sid], now, now_epoch, git, jira, conventions, counts, cost_db,
                            claude_home)
        except Exception as e:  # noqa: BLE001  (one bad session never stops the others)
            _log("could not record {}: {}: {}".format(sid, type(e).__name__, e))
            counts["skipped"] += 1
        if _info(state, sid) != before:
            save(state)
    return counts


def rehome_recent(conn, now: str, jira: Callable, conventions: dict, days: int = 30, only_failed: bool = False,
                  after: Optional[str] = None, out_of_time: Callable[[], bool] = lambda: False) -> Dict[str, object]:
    """Work out the home again for each session with an episode in the last `days` days; a row is written only when
    the answer changed (a ticket moved epic, the registry changed), or when a failed Jira read can now be repeated.
    only_failed limits it to homes written while Jira was down, which the job retries on every pass.

    Sessions go in session_uid order, starting after `after`. JP-181: it stops when `out_of_time()` says so and
    returns {"homes", "done": False, "next"}: pass `next` as `after` to carry on. A finished run says "done": True."""
    since = _stamp(_epoch(now) - days * 86400)
    rows = conn.execute(
        """SELECT e.session_uid, e.episode, e.folder, e.repo, e.branch FROM current_session_episodes e
           WHERE e.episode = (SELECT MAX(e2.episode) FROM current_session_episodes e2 WHERE e2.session_uid = e.session_uid)
             AND e.quiet_at >= ? AND e.session_uid > ? ORDER BY e.session_uid""", (since, after or "")).fetchall()
    written = 0
    for uid, number, folder, repo, branch in rows:
        if out_of_time():
            return {"homes": written, "done": False, "next": after}
        after = uid
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
    return {"homes": written, "done": True, "next": None}


def recopy_costs_recent(conn, cost_db, now: str, days: int = 30, after: Optional[str] = None,
                        out_of_time: Callable[[], bool] = lambda: False) -> Dict[str, object]:
    """Copy cost again for recent sessions, so a re-pricing or later usage adds a new batch. Stops and resumes like
    rehome_recent (JP-181)."""
    since = _stamp(_epoch(now) - days * 86400)
    written = 0
    for uid, sid in conn.execute(
            """SELECT DISTINCT s.session_uid, s.tool_session_id FROM sessions s
               JOIN current_session_episodes e ON e.session_uid = s.session_uid
               WHERE e.quiet_at >= ? AND s.session_uid > ? ORDER BY s.session_uid""",
            (since, after or "")).fetchall():
        if out_of_time():
            return {"costs": written, "done": False, "next": after}
        after = uid
        try:
            with db.transaction(conn):
                written += costs.copy_costs(conn, cost_db, uid, sid, now)
        except Exception as e:  # noqa: BLE001
            _log("could not re-copy cost for {}: {}: {}".format(uid, type(e).__name__, e))
    return {"costs": written, "done": True, "next": None}


def once_per_run(jira: Callable[[str], Optional[dict]]) -> Callable[[str], Optional[dict]]:
    """The Jira reader, remembering each ticket's answer for the rest of the run (JP-181). Many sessions share a
    ticket (a graph run starts several, each with subagents), and a ticket's epic does not change within minutes. A
    failed read is remembered too: Jira that did not answer a moment ago is not asked again, 10 s at a time, in the
    same run; the next run asks again."""
    seen: Dict[str, Optional[dict]] = {}

    def read(key: str) -> Optional[dict]:
        if key not in seen:
            seen[key] = jira(key)
        return seen[key]

    return read


def run(conn, state: Dict[str, object], *, now: str, spool: Path, projects: Path, git: GitRun, jira: Callable,
        conventions: dict, cost_db=None, claude_home: Optional[Path] = None, budget: float = BUDGET_SECONDS,
        clock: Callable[[], float] = time.monotonic,
        save: Callable[[Dict[str, object]], None] = lambda state: None) -> Dict[str, int]:
    """One run of the job: a recording pass, then the once-a-day re-home and cost re-copy (or, on other runs, the
    homes written while Jira was down). Nothing new starts once `budget` seconds have gone by: the counts then say
    "deferred": 1, and the next run carries on from the saved mark. `save` is given the state at every step."""
    deadline = clock() + budget
    out_of_time = lambda: clock() >= deadline  # noqa: E731
    jira = once_per_run(jira)
    counts = record_pass(conn, now=now, spool=spool, projects=projects, git=git, jira=jira, conventions=conventions,
                         state=state, cost_db=cost_db, claude_home=claude_home, out_of_time=out_of_time, save=save)
    deferred = out_of_time()
    today = now[:10]
    if state.get("rehomed") != today:  # once a day: a ticket's epic or the registry may have changed, costs re-priced
        daily = state.get("rehome")
        if not isinstance(daily, dict) or daily.get("day") != today:
            daily = state["rehome"] = {"day": today, "homes_done": False, "after": None}
        if not daily["homes_done"]:
            done = rehome_recent(conn, now, jira, conventions, after=daily["after"], out_of_time=out_of_time)
            counts["homes"] += done["homes"]
            daily.update(homes_done=bool(done["done"]), after=done["next"])
            save(state)
        if daily["homes_done"]:
            done = recopy_costs_recent(conn, cost_db, now, after=daily["after"], out_of_time=out_of_time)
            counts["costs"] += done["costs"]
            daily["after"] = done["next"]
            if done["done"]:
                state["rehomed"] = today
                state.pop("rehome", None)
            save(state)
        deferred = deferred or state.get("rehomed") != today
    else:  # every other run: homes written while Jira was down are repeated, carrying on where the last run stopped
        done = rehome_recent(conn, now, jira, conventions, only_failed=True, after=state.get("retry_after"),
                             out_of_time=out_of_time)
        counts["homes"] += done["homes"]
        state["retry_after"] = done["next"]
        deferred = deferred or not done["done"]
        save(state)
    counts["deferred"] = int(deferred)
    return counts


def _conventions_version() -> str:
    try:
        out = common.git(["log", "-1", "--format=%h", "--", "conventions"], common.REPO_ROOT, check=False)
        return out.stdout.strip() or "unknown"
    except Exception:  # noqa: BLE001
        return "unknown"


def main(argv: Optional[List[str]] = None) -> int:
    from ledger import jira_read
    argv = sys.argv[1:] if argv is None else argv
    budget = float(argv[1]) if len(argv) == 2 and argv[0] == "--budget" else BUDGET_SECONDS
    mark_file = common.state_dir() / "ledger-record.json"
    state = common.read_json(mark_file, None) or _new_state()
    conv = homes.load_conventions(_conventions_version(), str(Path.home()))
    names = [s["name"] for s in conv["registry"].get("systems") or []]
    fetch = jira_read.make_fetch(os.environ)
    conn = db.connect_existing(db.ledger_path())
    cost_db = costs.open_cost_ledger(costs.default_path(Path.home() / ".claude"))
    now = common.now_utc()
    jira = lambda key: jira_read.ticket_context(key, fetch, names)  # noqa: E731
    lane = common.Lane()
    save = lambda st: lane.write_text(mark_file, common.dump_json(st))  # noqa: E731
    try:
        counts = run(conn, state, now=now, spool=spool.spool_dir(), projects=Path.home() / ".claude" / "projects",
                     git=real_git, jira=jira, conventions=conv, cost_db=cost_db, claude_home=Path.home() / ".claude",
                     budget=budget, save=save)
    finally:
        conn.close()
        if cost_db is not None:
            cost_db.close()
    save(state)
    if counts["deferred"]:
        _log("stopped at the {:.0f}s budget; the next run carries on".format(budget))
    print(json.dumps(counts, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
