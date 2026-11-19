"""Made-up laptops for the loose-ends tests (JP-109): real git repositories in a temp folder, a ledger with sessions
that touched them, and fake Jira and GitHub answers. No real repository, session, ticket or pull request appears here.
"""
import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ledger_helpers import NOW, T, LedgerCase  # noqa: E402,F401
from ledger.live import Live  # noqa: E402

LATER = "2026-12-01T12:00:00Z"  # two weeks and more after NOW
ENV = dict(os.environ, GIT_AUTHOR_NAME="Test", GIT_AUTHOR_EMAIL="t@example.test", GIT_COMMITTER_NAME="Test",
           GIT_COMMITTER_EMAIL="t@example.test", GIT_TERMINAL_PROMPT="0")


def git(cwd, *args):
    result = subprocess.run(["git", "-C", str(cwd)] + list(args), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            universal_newlines=True, env=ENV)
    if result.returncode != 0:
        raise AssertionError("git {} failed: {}".format(" ".join(args), result.stderr))
    return result.stdout.strip()


def fake_live(tickets=None, prs=None):
    """Live with Jira answers {key: (status name, done)} or {key: (status name, done, flagged)} and pull request states
    {url: state}; a key or url that is not in the dictionary cannot be read."""
    tickets, prs = tickets or {}, prs or {}

    def fetch(path):
        key = path.split("/issue/")[1].split("?")[0]
        if key not in tickets:
            return None
        name, done, *flagged = tickets[key]
        fields = {"status": {"name": name, "statusCategory": {"key": "done" if done else "indeterminate"}}}
        if flagged and flagged[0]:
            fields["customfield_10021"] = [{"value": "Impediment"}]
        return {"fields": fields}

    class Result:
        def __init__(self, stdout="", returncode=0):
            self.stdout, self.returncode = stdout, returncode

    def run(cmd, **kwargs):
        state = prs.get(cmd[3])
        return Result('{"state": "%s"}' % state) if state else Result("", 1)

    return Live(fetch=fetch, run=run)


class LaptopCase(LedgerCase):
    """origin (bare), repo (a clone of it with main pushed), and helpers to make the work a session leaves behind."""

    def setUp(self):
        super().setUp()
        # macOS puts temp folders under /var, a link to /private/var; git and loose_ends.py report the real path.
        self.tmp = Path(os.path.realpath(str(self.tmp)))
        self.origin = self.tmp / "origin.git"
        self.repo = self.tmp / "work" / "josh_360"
        self.repo.parent.mkdir()
        subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(self.origin)], check=True, env=ENV)
        subprocess.run(["git", "clone", "-q", str(self.origin), str(self.repo)], check=True, env=ENV,
                       stderr=subprocess.DEVNULL)
        git(self.repo, "checkout", "-q", "-b", "main")
        self.commit(self.repo, "first")
        git(self.repo, "push", "-q", "-u", "origin", "main")
        git(self.repo, "remote", "set-head", "origin", "main")
        self.n = 0

    def commit(self, where, name):
        path = Path(where) / (name + ".txt")
        path.write_text(name)
        git(where, "add", ".")
        git(where, "commit", "-q", "-m", name)
        return git(where, "rev-parse", "HEAD")

    def branch_with_commit(self, name, push=False):
        git(self.repo, "checkout", "-q", "-b", name, "main")
        sha = self.commit(self.repo, name.replace("/", "-"))
        if push:
            git(self.repo, "push", "-q", "-u", "origin", name)
        git(self.repo, "checkout", "-q", "main")
        return sha

    def merge_to_main(self, name):
        git(self.repo, "merge", "-q", "--no-ff", "-m", "merge " + name, name)
        git(self.repo, "push", "-q", "origin", "main")

    def seed(self, sid, root=None, branch=None, commits=(), pr=None, ticket=None, worktree=None, quiet=T,
             git_root=None):
        """A session that touched these things, as the recorder would have written them."""
        root = str(root or self.repo)
        uid = self.session(sid)
        self.conn.execute(
            "INSERT INTO session_episodes (session_uid, episode, began_at, last_activity_at, quiet_at, end_reason, "
            "folder, git_root, branch, worktree_path, title, title_source, recorded_at, recorded_by) "
            "VALUES (?, 1, ?, ?, ?, 'quiet', ?, ?, ?, ?, 'A title', 'ai', ?, 'test')",
            (uid, T, T, quiet, root, git_root or root, branch, worktree, T))
        refs = [("folder", root)] + ([("branch", branch)] if branch else []) + [("commit", c) for c in commits] \
            + ([("pr", pr)] if pr else []) + ([("worktree", worktree)] if worktree else [])
        for kind, value in refs:
            self.conn.execute(
                "INSERT INTO session_refs (session_uid, episode, kind, repo, value, source, observed_at, recorded_at, "
                "recorded_by) VALUES (?, 1, ?, '', ?, 'git', ?, ?, 'test')", (uid, kind, value, T, T))
        if ticket:
            self.conn.execute(
                "INSERT INTO ticket_links (session_uid, tracker, ticket_key, relation, source, linked_at, recorded_by) "
                "VALUES (?, 'jira', ?, 'touched', 'branch', ?, 'test')", (uid, ticket, T))
        return uid

    def loose(self, live=None, now=NOW, session=None):
        from ledger import loose_ends
        return loose_ends.collect(self.conn, live or fake_live(), now, session)

    def kinds(self, result):
        return sorted((i["kind"], i.get("branch") or i.get("ticket") or i.get("url") or "") for i in result["items"])
