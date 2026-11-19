"""Loose ends, worked out when asked (JP-109). Python 3.9, standard library only.

    python3 ledger/loose_ends.py [list] [--session <id>] [--kind <kind>] [--limit N] [--json] [--check] [--fetch]
    python3 ledger/loose_ends.py keep   --folder <path in the repo> --branch <name> [--note <text>]
    python3 ledger/loose_ends.py unkeep --folder <path in the repo> --branch <name>

Josh's definition of a loose end, checked live against git, GitHub and Jira as they are at this moment:

    commits-unhoused   commits a session made that are on no branch and in no pull request
    unpushed-branch    a local branch with commits that are not on any remote branch
    ticket-not-done    a ticket a session was linked to that is not Done
    open-pr            a pull request a session opened that is still open
    leftover-worktree  a worktree a session used that is still there
    orphaned-branch    a branch a session touched that nothing is using (merged and left, or pushed and forgotten),
                       unless Josh marked it kept on purpose
    closed-pr-branch   a remote ticket branch (`<KEY>-*`) a session touched, with no local copy, whose pull requests
                       were all closed without merging (the graphs' `close-unmerged` keeps it on purpose, JP-174),
                       unless Josh marked it kept

The ledger only says which session touched which folder, branch, commit, worktree, pull request and ticket
(`session_refs`, `current_homes`, `ticket_links`). Nothing here is stored: no table, no file, no reminder, so a
day Josh skips loses nothing. Only the laptop's own sessions count (JP-149): a pull request or branch no local session
touched is never listed. A check that cannot be made (no `gh`, Jira unreachable, a folder that is gone) goes in
`unchecked` with its reason. It is never read as "no loose end".

The one write is `keep` / `unkeep`: a row in `branch_marks`, marked by Josh, keyed by the main checkout of the
repository. `list` never writes, and never touches the network unless `--fetch` is given (then
`git fetch --prune` in each repository, which only moves remote-tracking refs).
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import sqlite3
import subprocess
import sys
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Set, TextIO, Tuple

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from ledger import _repo  # noqa: E402,F401
from laptop import common  # noqa: E402
from ledger import ask, db  # noqa: E402
from ledger.live import Live  # noqa: E402
from ledger.text import short_text  # noqa: E402

KINDS = ("commits-unhoused", "unpushed-branch", "ticket-not-done", "open-pr", "leftover-worktree", "orphaned-branch",
         "closed-pr-branch")
BY = "ledger/loose_ends.py"
WORKTREES_DIR = "/.claude/worktrees/"
TICKET_BRANCH = re.compile(r"^[A-Z][A-Z0-9]*-[0-9]+[-/].")   # <KEY>-<slug>, or <KEY>/<slug> made by hand
MAX_TIPS = 100  # more unhoused commits than this in one repository: one item per commit, no grouping

REFS_SQL = """SELECT r.session_uid, r.kind, r.value, e.git_root, e.folder
FROM session_refs r
LEFT JOIN current_session_episodes e ON e.session_uid = r.session_uid AND e.episode = r.episode
WHERE r.kind IN ('commit', 'branch', 'pr', 'worktree')
  AND NOT EXISTS (SELECT 1 FROM live_corrections c WHERE c.table_name = 'session_refs' AND c.row_id = r.id)"""
EPISODES_SQL = "SELECT session_uid, git_root, folder, worktree_path, quiet_at FROM current_session_episodes"
TICKETS_SQL = """SELECT session_uid, tracker, ticket_key FROM current_homes WHERE ticket_key IS NOT NULL
UNION
SELECT t.session_uid, t.tracker, t.ticket_key FROM ticket_links t
WHERE t.session_uid IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM live_corrections c WHERE c.table_name = 'ticket_links' AND c.row_id = t.id)"""


# -- git ---------------------------------------------------------------------------------------------------------

def git(root: str, *args: str) -> Optional[str]:
    """Standard output of `git -C root args`, or None when git failed (a missing folder, not a repository)."""
    try:
        result = subprocess.run(["git", "-C", root] + list(args), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                universal_newlines=True, timeout=120, env=dict(os.environ, GIT_TERMINAL_PROMPT="0"))
    except (OSError, subprocess.SubprocessError):
        return None
    return result.stdout if result.returncode == 0 else None


def git_ok(root: str, *args: str) -> bool:
    return git(root, *args) is not None


def resolve_root(path: Optional[str]) -> Optional[str]:
    """The main checkout of the repository a path belongs to (a linked worktree resolves to its main checkout).

    A path that is gone falls back to the part before `/.claude/worktrees/`, where Claude Code puts its worktrees.
    None when no repository can be found."""
    if not path:
        return None
    if os.path.isdir(path):
        common_dir = git(path, "rev-parse", "--git-common-dir")
        if common_dir is None:
            return None
        common_dir = common_dir.strip()
        absolute = common_dir if os.path.isabs(common_dir) else os.path.join(path, common_dir)
        absolute = os.path.realpath(absolute)
        return os.path.dirname(absolute) if os.path.basename(absolute) == ".git" else absolute
    if WORKTREES_DIR in path:
        return resolve_root(path.split(WORKTREES_DIR)[0])
    return None


class Repo:
    """What git says about one repository right now. Everything is read once."""

    def __init__(self, root: str) -> None:
        self.root = root
        self.local: Dict[str, str] = {}
        self.remote: Dict[str, List[str]] = {}
        self.worktrees: List[dict] = []
        self.default_ref: Optional[str] = None
        self.default_names: Set[str] = {"main", "master"}
        self._housed: Optional[Set[str]] = None
        refs = git(root, "for-each-ref", "--format=%(refname)%09%(objectname)", "refs/heads", "refs/remotes")
        self.ok = refs is not None
        for line in (refs or "").splitlines():
            name, _, sha = line.partition("\t")
            if name.startswith("refs/heads/"):
                self.local[name[len("refs/heads/"):]] = sha
            elif name.startswith("refs/remotes/"):
                _, _, branch = name[len("refs/remotes/"):].partition("/")
                if branch and branch != "HEAD":
                    self.remote.setdefault(branch, []).append(sha)
        self._read_worktrees()
        self._find_default()

    def _read_worktrees(self) -> None:
        text = git(self.root, "worktree", "list", "--porcelain") or ""
        for block in text.strip().split("\n\n"):
            entry: dict = {"path": "", "branch": None, "head": None, "prunable": False}
            for line in block.splitlines():
                key, _, value = line.partition(" ")
                if key == "worktree":
                    entry["path"] = value
                elif key == "HEAD":
                    entry["head"] = value
                elif key == "branch" and value.startswith("refs/heads/"):
                    entry["branch"] = value[len("refs/heads/"):]
                elif key == "prunable":
                    entry["prunable"] = True
            if entry["path"]:
                entry["main"] = not self.worktrees
                self.worktrees.append(entry)

    def _find_default(self) -> None:
        pointed = (git(self.root, "symbolic-ref", "-q", "refs/remotes/origin/HEAD") or "").strip()
        if pointed:
            self.default_names.add(pointed.rsplit("/", 1)[-1])
        for ref in ([pointed] if pointed else []) + ["refs/remotes/origin/main", "refs/remotes/origin/master",
                                                      "refs/heads/main", "refs/heads/master"]:
            if git_ok(self.root, "rev-parse", "--verify", "--quiet", ref + "^{commit}"):
                self.default_ref = ref
                return

    def is_default(self, branch: str) -> bool:
        return branch in self.default_names

    def merged(self, ref: str) -> Optional[bool]:
        """Whether everything on `ref` is already on the default branch. None when there is no default branch."""
        if self.default_ref is None:
            return None
        return git_ok(self.root, "merge-base", "--is-ancestor", ref, self.default_ref)

    def pushed(self, branch: str) -> bool:
        """Whether the local branch's tip is on a remote branch of the same name."""
        return any(git_ok(self.root, "merge-base", "--is-ancestor", self.local[branch], sha)
                   for sha in self.remote.get(branch, []))

    def housed(self) -> Set[str]:
        if self._housed is None:
            out = git(self.root, "rev-list", "--branches", "--remotes", "--tags")
            self._housed = set((out or "").split())
        return self._housed

    def exists(self, shas: Iterable[str]) -> Set[str]:
        found: Set[str] = set()
        try:
            result = subprocess.run(["git", "-C", self.root, "cat-file", "--batch-check"], input="\n".join(shas) + "\n",
                                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, universal_newlines=True,
                                    timeout=120)
        except (OSError, subprocess.SubprocessError):
            return found
        for line in result.stdout.splitlines():
            parts = line.split()
            if len(parts) >= 2 and parts[1] == "commit":
                found.add(parts[0])
        return found

    def checked_out(self, branch: str) -> bool:
        return any(w["branch"] == branch for w in self.worktrees)

    def worktree(self, path: str) -> Optional[dict]:
        target = os.path.realpath(path)
        for entry in self.worktrees:
            if os.path.realpath(entry["path"]) == target:
                return entry
        return None


# -- collecting --------------------------------------------------------------------------------------------------

class Collector:
    def __init__(self, conn: sqlite3.Connection, live: Live, now: str, fetch: bool = False) -> None:
        self.conn, self.live, self.now, self.fetch = conn, live, now, fetch
        self.items: Dict[str, dict] = {}
        self.unchecked: Dict[str, dict] = {}
        self._roots: Dict[str, Optional[str]] = {}
        self._repos: Dict[str, Repo] = {}
        self.kept: Set[Tuple[str, str]] = set(self.conn.execute("SELECT git_root, branch FROM kept_branches"))
        self.quiet: Dict[str, str] = {}
        for uid, started in self.conn.execute("SELECT session_uid, started_at FROM sessions"):
            self.quiet[uid] = started
        self.pr_urls: Dict[str, Set[str]] = {}
        self.skip_tickets: Set[str] = set()

    def skip(self, reason: str, example: str) -> None:
        entry = self.unchecked.setdefault(reason, {"reason": reason, "count": 0, "examples": []})
        entry["count"] += 1
        if example not in entry["examples"] and len(entry["examples"]) < 3:
            entry["examples"].append(example)

    def root(self, path: Optional[str]) -> Optional[str]:
        if path not in self._roots:
            self._roots[path or ""] = resolve_root(path)
        return self._roots[path or ""]

    def repo(self, root: str) -> Repo:
        if root not in self._repos:
            if self.fetch:
                git(root, "fetch", "--prune", "--quiet")
            self._repos[root] = Repo(root)
        return self._repos[root]

    def add(self, kind: str, key: str, uids: Iterable[str], detail: str, **facts: object) -> None:
        item = self.items.setdefault(kind + ":" + key, {"id": kind + ":" + key, "kind": kind, "sessions": set(),
                                                         "detail": detail, **facts})
        item["sessions"].update(uids)

    # -- the passes ----------------------------------------------------------------------------------------------

    def run(self, only: Optional[Set[str]]) -> None:
        def wanted(uid: str) -> bool:
            return only is None or uid in only

        episodes = [r for r in self.conn.execute(EPISODES_SQL) if wanted(r[0])]
        seen: Set[str] = set()
        for uid, _, _, _, quiet in episodes:  # a session's age is when it last went quiet
            if quiet and (uid not in seen or quiet > self.quiet[uid]):
                self.quiet[uid] = quiet
                seen.add(uid)
        refs = [r for r in self.conn.execute(REFS_SQL) if wanted(r[0])]
        commits: Dict[str, Dict[str, Set[str]]] = {}
        branches: Dict[str, Dict[str, Set[str]]] = {}
        worktrees: Dict[str, Dict[str, Set[str]]] = {}
        for uid, kind, value, git_root, folder in refs:
            if kind == "pr":
                self.pr_urls.setdefault(uid, set()).add(value)
                continue
            if kind == "worktree":
                continue  # found from the episodes below, which know the repository
            root = self.root(git_root) or self.root(folder)
            if root is None:
                self.skip("folder is gone or not a git repository", git_root or folder or "no folder recorded")
                continue
            (commits if kind == "commit" else branches).setdefault(root, {}).setdefault(value, set()).add(uid)
        for uid, git_root, folder, worktree_path, _ in episodes:
            root = self.root(git_root) or self.root(folder)
            candidates = {worktree_path} if worktree_path else set()
            if git_root:
                candidates.add(git_root)
            for path in (r[2] for r in refs if r[0] == uid and r[1] == "worktree"):
                candidates.add(path)
            for path in candidates:
                if root is not None and path:
                    worktrees.setdefault(root, {}).setdefault(path, set()).add(uid)
        for root in sorted(set(commits) | set(branches) | set(worktrees)):
            repo = self.repo(root)
            if not repo.ok:
                self.skip("git could not be read", root)
                continue
            self._commits(repo, commits.get(root, {}))
            self._branches(repo, branches.get(root, {}))
            self._worktrees(repo, worktrees.get(root, {}))
        self._pull_requests()
        self._tickets(only)

    def _commits(self, repo: Repo, owners: Dict[str, Set[str]]) -> None:
        if not owners:
            return
        present = repo.exists(owners)
        for sha in owners:
            if sha not in present:
                self.skip("a commit is no longer in git", repo.root)
        loose = {s: {u for u in us if not self.pr_urls.get(u)} for s, us in owners.items()
                 if s in present and s not in repo.housed()}
        loose = {s: us for s, us in loose.items() if us}  # a session with a pull request put its commits somewhere
        if not loose:
            return
        tips = list(loose)
        if len(loose) <= MAX_TIPS:
            out = git(repo.root, "merge-base", "--independent", *loose)
            tips = out.split() if out else tips
        for tip in tips:
            members = [sha for sha in loose if sha == tip or git_ok(repo.root, "merge-base", "--is-ancestor", sha, tip)]
            uids: Set[str] = set().union(*(loose[sha] for sha in members)) if members else set(loose.get(tip, set()))
            count = max(len(members), 1)
            self.add("commits-unhoused", repo.root + ":" + tip, uids,
                     "{} commit{} on no branch and in no pull request".format(count, "" if count == 1 else "s"),
                     root=repo.root, commit=tip, commits=count)

    def _branches(self, repo: Repo, owners: Dict[str, Set[str]]) -> None:
        for branch, uids in sorted(owners.items()):
            if repo.is_default(branch) or (repo.root, branch) in self.kept:
                continue
            if branch not in repo.local:
                self._remote_branch(repo, branch, uids)
                continue
            pushed = repo.pushed(branch)
            merged = repo.merged("refs/heads/" + branch)
            facts = {"root": repo.root, "branch": branch}
            if not pushed and not merged:
                self.add("unpushed-branch", repo.root + ":" + branch, uids,
                         "local branch with commits that are on no remote branch", **facts)
                continue
            if repo.checked_out(branch):
                continue  # a worktree or the main checkout is using it
            if merged:
                state = "merged into the default branch, local copy left" if branch in repo.remote else \
                    "merged into the default branch, no remote copy"
                self.add("orphaned-branch", repo.root + ":" + branch, uids, state, state_name="merged", **facts)
                continue
            urls = {url for uid in uids for url in self.pr_urls.get(uid, set())}
            states = [self.live.pr(url) for url in urls]
            if "OPEN" in states:
                continue  # an open pull request is its own item
            if None in states:
                self.skip("GitHub could not be read (gh)", branch)
                continue
            self.add("orphaned-branch", repo.root + ":" + branch, uids,
                     "pushed, not merged, and no open pull request", state_name="pushed", **facts)

    def _remote_branch(self, repo: Repo, branch: str, uids: Set[str]) -> None:
        """A ticket branch that is only on the remote: loose when its pull requests were all closed without merging."""
        if branch not in repo.remote or not TICKET_BRANCH.match(branch):
            return
        prs = self.live.branch_prs(repo.root, branch)
        if prs is None:
            self.skip("GitHub could not be read (gh)", branch)
            return
        if not prs or any(p["state"] != "CLOSED" for p in prs):
            return              # never had a pull request, or one is open or merged: not this kind
        self.add("closed-pr-branch", repo.root + ":" + branch, uids,
                 "remote branch of a pull request closed without merging", root=repo.root, branch=branch,
                 url=prs[0]["url"])

    def _worktrees(self, repo: Repo, owners: Dict[str, Set[str]]) -> None:
        for path, uids in sorted(owners.items()):
            entry = repo.worktree(path)
            if entry is None or entry["main"]:
                continue
            exists = os.path.isdir(entry["path"])
            dirty = ignored = 0
            if exists:
                dirty = len((git(entry["path"], "status", "--porcelain") or "").splitlines())
                everything = len((git(entry["path"], "status", "--porcelain", "--ignored") or "").splitlines())
                ignored = max(everything - dirty, 0)
            detail = "worktree is still there" if exists else "worktree is registered but its folder is gone"
            self.add("leftover-worktree", repo.root + ":" + entry["path"], uids, detail, root=repo.root,
                     path=entry["path"], branch=entry["branch"], head=entry["head"], folder_exists=exists,
                     uncommitted=dirty, ignored_files=ignored)

    def _pull_requests(self) -> None:
        by_url: Dict[str, Set[str]] = {}
        for uid, urls in self.pr_urls.items():
            for url in urls:
                by_url.setdefault(url, set()).add(uid)
        for url, uids in sorted(by_url.items()):
            state = self.live.pr(url)
            if state is None:
                self.skip("GitHub could not be read (gh)", url)
            elif state == "OPEN":
                self.add("open-pr", url, uids, "pull request is open", url=url)

    def _tickets(self, only: Optional[Set[str]]) -> None:
        by_key: Dict[Tuple[str, str], Set[str]] = {}
        for uid, tracker, key in self.conn.execute(TICKETS_SQL):
            if (only is None or uid in only) and key not in self.skip_tickets:
                by_key.setdefault((tracker or "jira", key), set()).add(uid)
        for (tracker, key), uids in sorted(by_key.items()):
            if tracker != "jira":
                self.skip("{} tickets are not checked yet".format(tracker), key)
                continue
            status = self.live.ticket(key)
            if status is None:
                self.skip("Jira could not be read", key)
            elif status["status"] == "Deployed" and not status.get("flagged"):
                continue        # in production and being watched (JP-167): nothing is waiting on Josh
            elif status["status"] == "Deployed":
                self.add("ticket-not-done", key, uids, "{} is Deployed: validation needs you".format(key), ticket=key,
                         status=status["status"])
            elif not status["done"]:
                self.add("ticket-not-done", key, uids, "{} is {}".format(key, status["status"]), ticket=key,
                         status=status["status"])


def _epoch(stamp: str) -> float:
    return datetime.datetime.strptime(stamp, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc).timestamp()


def collect(conn: sqlite3.Connection, live: Optional[Live] = None, now: Optional[str] = None,
            session: Optional[str] = None, fetch: bool = False, sessions: Optional[Iterable[str]] = None,
            skip_tickets: Iterable[str] = ()) -> dict:
    """{"as_of", "items", "unchecked", "counts"}. Items are oldest first; each carries its sessions and its age.

    `session` narrows to one session by its ledger id or tool session id; `sessions` to a set of ledger ids (the
    no-loose-ends gate passes a graph run's sessions, JP-161). An empty set lists nothing. Tickets in `skip_tickets`
    are neither read nor listed (the gate's own run ticket, whose status is the graph's to set)."""
    now = now or common.now_utc()
    only: Optional[Set[str]] = None
    if sessions is not None:
        if session:
            raise ValueError("give one session or a set of sessions, not both")
        only = set(sessions)
    elif session:
        only = {r[0] for r in conn.execute(
            "SELECT session_uid FROM sessions WHERE session_uid = ? OR tool_session_id = ?", (session, session))}
        if not only:
            raise ValueError("no session {} in the ledger".format(session))
    collector = Collector(conn, live or Live(), now, fetch)
    collector.skip_tickets = set(skip_tickets)
    collector.run(only)
    items = []
    for item in collector.items.values():
        uids = sorted(item["sessions"])
        since = min(collector.quiet.get(u, now) for u in uids)
        item = dict(item, sessions=uids, since=since, age_days=max(int((_epoch(now) - _epoch(since)) // 86400), 0))
        items.append(item)
    items.sort(key=lambda i: (i["since"], i["id"]))
    counts: Dict[str, int] = {}
    for item in items:
        counts[item["kind"]] = counts.get(item["kind"], 0) + 1
    return {"as_of": now, "items": items, "unchecked": sorted(collector.unchecked.values(), key=lambda u: u["reason"]),
            "counts": counts}


# -- the kept-on-purpose mark ------------------------------------------------------------------------------------

def mark(conn: sqlite3.Connection, folder: str, branch: str, kept: bool, note: Optional[str], now: str) -> str:
    """Write the mark. Returns the repository's main checkout. ValueError when the folder or branch is not right."""
    root = resolve_root(folder)
    if root is None:
        raise ValueError("{} is not inside a git repository".format(folder))
    repo = Repo(root) if kept else None
    if repo is not None and branch not in repo.local and branch not in repo.remote:
        raise ValueError("there is no local or remote branch {} in {}".format(branch, root))
    text, withheld = short_text(note, 200)
    if withheld:
        raise ValueError("the note looks like it holds patient data; say it another way")
    with db.transaction(conn):
        conn.execute("INSERT INTO branch_marks (git_root, branch, mark, note, marked_at, marked_by, recorded_by) "
                     "VALUES (?, ?, ?, ?, ?, 'josh', ?)",
                     (root, branch, "kept" if kept else "not-kept", text, now, BY))
    return root


# -- output ------------------------------------------------------------------------------------------------------

def render_text(result: dict, kinds: Optional[List[str]] = None, limit: int = 40, title: str = "Loose ends") -> str:
    items = [i for i in result["items"] if not kinds or i["kind"] in kinds]
    lines = ["{}: {} as of {} (this laptop's sessions only)".format(title, len(items), result["as_of"])]
    shown = 0
    for kind in KINDS:
        group = [i for i in items if i["kind"] == kind]
        if not group:
            continue
        lines.append("")
        lines.append("{} ({})".format(kind, len(group)))
        for item in group:
            if shown >= limit:
                break
            shown += 1
            where = os.path.basename(item["root"]) if item.get("root") else ""
            what = item.get("branch") or item.get("ticket") or item.get("url") or (item.get("commit") or "")[:9] \
                or os.path.basename(item.get("path") or "")
            lines.append("  {:>4}d  {}  {}  {}  [{} session{}]".format(
                item["age_days"], where, what, item["detail"], len(item["sessions"]),
                "" if len(item["sessions"]) == 1 else "s"))
    if len(items) > shown:
        lines.append("")
        lines.append("{} more not shown; use --limit, --kind or --json.".format(len(items) - shown))
    if not items:
        lines.append("Nothing is loose.")
    if result["unchecked"]:
        lines.append("")
        lines.append("Could not check (these are not clean, only unknown):")
        for entry in result["unchecked"]:
            lines.append("  {} x {} (e.g. {})".format(entry["count"], entry["reason"], ", ".join(entry["examples"])))
    return "\n".join(lines)


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="command")
    for name in ("list", None):
        target = sub.add_parser("list") if name else p
        target.add_argument("--session", help="one session: its ledger id or its tool session id")
        target.add_argument("--kind", action="append", choices=KINDS)
        target.add_argument("--limit", type=int, default=40, help="most items printed as text")
        target.add_argument("--json", action="store_true")
        target.add_argument("--check", action="store_true", help="exit 1 when anything is loose")
        target.add_argument("--fetch", action="store_true", help="git fetch --prune in each repository first")
    for name in ("keep", "unkeep"):
        k = sub.add_parser(name)
        k.add_argument("--folder", required=True)
        k.add_argument("--branch", required=True)
        if name == "keep":
            k.add_argument("--note")
    return p


def main(argv: Optional[List[str]] = None, out: Optional[TextIO] = None, path: Optional[Path] = None,
         live: Optional[Live] = None, now: Optional[str] = None) -> int:
    out = out or sys.stdout
    args = _parser().parse_args(argv)
    command = args.command or "list"
    try:
        if command in ("keep", "unkeep"):
            conn = db.connect_existing(path or db.ledger_path())
            try:
                root = mark(conn, args.folder, args.branch, command == "keep", getattr(args, "note", None),
                            now or common.now_utc())
            finally:
                conn.close()
            out.write("{} {} in {}\n".format("kept" if command == "keep" else "no longer kept", args.branch, root))
            return 0
        conn = ask.open_read_only(path or db.ledger_path())
        try:
            result = collect(conn, live, now, args.session, args.fetch)
        finally:
            conn.close()
    except (FileNotFoundError, sqlite3.Error, ValueError) as e:
        print("loose_ends: {}".format(e), file=sys.stderr)
        return 2
    if args.kind:
        result["items"] = [i for i in result["items"] if i["kind"] in args.kind]
    if args.json:
        out.write(json.dumps(result, sort_keys=True, indent=1) + "\n")
    else:
        out.write(render_text(result, args.kind, args.limit,
                              "Loose ends for session " + args.session if args.session else "Loose ends") + "\n")
    return 1 if args.check and result["items"] else 0


if __name__ == "__main__":
    sys.exit(main())
