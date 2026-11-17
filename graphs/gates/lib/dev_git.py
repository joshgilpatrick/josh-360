"""`git` calls for the development gates (JP-115). Python 3.9, standard library only.

Every call has a timeout, and none prints file content. The worktree helpers come in Task 7; `clone_of` is here
because `lint-spec` needs it to keep the work folder out of the repository.
"""
from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Optional

GIT_TIMEOUT = 120
WORKTREES = (".claude", "worktrees")


class GitError(Exception):
    """A git call failed. The message is git's first line of stderr, never file content."""


def git(cwd: Path, *args: str, check: bool = True) -> str:
    try:
        done = subprocess.run(["git"] + list(args), cwd=str(cwd), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              universal_newlines=True, timeout=GIT_TIMEOUT)
    except (OSError, subprocess.SubprocessError) as exc:
        raise GitError("git could not run: {}".format(exc.__class__.__name__))
    if check and done.returncode != 0:
        first = (done.stderr or done.stdout or "no output").strip().splitlines()[:1] or ["no output"]
        raise GitError("git {} failed: {}".format(args[0] if args else "", first[0][:160]))
    return done.stdout.strip()


def clone_of(worktree: Path) -> Path:
    """The repository a worktree belongs to: the folder above `.claude/worktrees/` when the worktree lives there,
    else the parent of git's common directory."""
    parts = Path(worktree).parts
    for i in range(len(parts) - 1):
        if parts[i:i + 2] == WORKTREES:
            return Path(*parts[:i]) if i else Path(parts[0])
    common = Path(git(Path(worktree), "rev-parse", "--path-format=absolute", "--git-common-dir"))
    return common.parent
