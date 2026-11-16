"""Test helpers: a made-up GitHub (a bare repo) and a made-up laptop home, both in a temp folder.

Nothing here touches the real home folder, the real josh-360 remote or any real data.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PY = sys.executable


def run(args, cwd, env, check=True, input_text=None):
    result = subprocess.run(args, cwd=str(cwd), env=env, input=input_text, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, universal_newlines=True)
    if check and result.returncode != 0:
        raise AssertionError("{} failed ({}):\n{}\n{}".format(args, result.returncode, result.stdout, result.stderr))
    return result


class LaptopCase(unittest.TestCase):
    """Builds: tmp/origin.git (GitHub), tmp/work (a developer clone that "merges" to main),
    tmp/home (the laptop's HOME) with home/.josh-360/repo cloned from origin on branch main."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="josh360-test-"))
        self.home = self.tmp / "home"
        self.home.mkdir()
        (self.home / "Documents").mkdir()
        (self.home / "Documents" / "notes.txt").write_text("Josh's own file\n")
        self.j360 = self.home / ".josh-360"
        self.origin = self.tmp / "origin.git"
        self.work = self.tmp / "work"
        self.laptop_repo = self.j360 / "repo"

        # A laptop whose git settings would break a careless job: signing on, and hooks that fail.
        bad_hooks = self.tmp / "bad-hooks"
        bad_hooks.mkdir()
        for name in ("pre-push", "pre-commit", "post-checkout"):
            hook = bad_hooks / name
            hook.write_text("#!/bin/sh\nexit 1\n")
            hook.chmod(0o755)
        gitconfig = self.tmp / "gitconfig"
        gitconfig.write_text("[commit]\n\tgpgsign = true\n[core]\n\thooksPath = {}\n"
                             "[init]\n\tdefaultBranch = main\n".format(bad_hooks))

        self.env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": str(self.home),
            "GIT_CONFIG_GLOBAL": str(gitconfig),
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_AUTHOR_NAME": "Test", "GIT_AUTHOR_EMAIL": "test@example.invalid",
            "GIT_COMMITTER_NAME": "Test", "GIT_COMMITTER_EMAIL": "test@example.invalid",
            "LANG": "C.UTF-8",
        }
        if os.environ.get("TMPDIR"):
            self.env["TMPDIR"] = os.environ["TMPDIR"]

        run(["git", "init", "--quiet", "--bare", str(self.origin)], self.tmp, self.env)
        run(["git", "init", "--quiet", "-b", "main", str(self.work)], self.tmp, self.env)
        self.copy_repo_into(self.work)
        self.commit("start")
        run(["git", "remote", "add", "origin", str(self.origin)], self.work, self.env)
        self.git_work("push", "--quiet", "origin", "main")
        run(["git", "-c", "core.hooksPath=/dev/null", "clone", "--quiet", "--branch", "main", str(self.origin), str(self.laptop_repo)],
            self.tmp, self.env)

    def tearDown(self):
        shutil.rmtree(str(self.tmp), ignore_errors=True)

    # -- the made-up GitHub ------------------------------------------------------------------

    def copy_repo_into(self, dest: Path):
        listed = run(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], REPO, os.environ)
        for rel in filter(None, listed.stdout.split("\0")):
            src = REPO / rel
            if not src.is_file() or rel.startswith("docs/proof/"):
                continue
            target = dest / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(str(src), str(target))

    def git_work(self, *args):
        return run(["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false"] + list(args),
                   self.work, self.env)

    def commit(self, message):
        self.git_work("add", "-A")
        self.git_work("commit", "--quiet", "-m", message)
        return self.git_work("rev-parse", "HEAD").stdout.strip()

    def merge(self, rel, text, message="a merged change"):
        """Simulate a pull request merged to main: commit in the work clone and push."""
        path = self.work / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        sha = self.commit(message)
        self.git_work("push", "--quiet", "origin", "main")
        return sha

    def origin_git(self, *args, check=True):
        return run(["git", "--git-dir", str(self.origin)] + list(args), self.tmp, self.env, check=check)

    def status_on_branch(self):
        return json.loads(self.origin_git("show", "laptop-status:status.json").stdout)

    def status_tree(self):
        return self.origin_git("ls-tree", "-r", "--name-only", "laptop-status").stdout.split()

    def status_commits(self):
        out = self.origin_git("rev-list", "--count", "laptop-status", check=False)
        return int(out.stdout.strip()) if out.returncode == 0 else 0

    # -- the made-up laptop ------------------------------------------------------------------

    def laptop(self, script, *args, check=False):
        return run([PY, str(self.laptop_repo / "laptop" / script)] + list(args), self.laptop_repo, self.env, check=check)

    def laptop_head(self):
        return run(["git", "rev-parse", "HEAD"], self.laptop_repo, self.env).stdout.strip()

    def snapshot(self, root: Path, skip=None):
        """Every file under root (except under skip) with its bytes and mode."""
        seen = {}
        for dirpath, dirnames, filenames in os.walk(str(root)):
            if skip and Path(dirpath) == skip.parent:
                dirnames[:] = [d for d in dirnames if d != skip.name]
            for name in filenames:
                p = Path(dirpath) / name
                if skip and (p == skip or skip in p.parents):
                    continue
                seen[str(p.relative_to(root))] = (p.read_bytes(), p.stat().st_mode)
            for name in dirnames:
                seen[str((Path(dirpath) / name).relative_to(root)) + "/"] = None
        return seen
