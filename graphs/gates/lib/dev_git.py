"""`git` calls for the development gates (JP-115). Python 3.9, standard library only.

Every call has a timeout, and none prints file content: a failure says git's first line of stderr and nothing more.
A worktree is `<clone>/.claude/worktrees/<branch>`, cut from `origin/<base>`; the clone itself is never touched.
"""
from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path
from typing import List, Optional, Tuple

GIT_TIMEOUT = 120
WORKTREES = (".claude", "worktrees")


class GitError(Exception):
    """A git call failed. The message is git's first line of stderr, never file content."""


def git(cwd: Path, *args: str, check: bool = True) -> str:
    try:
        done = subprocess.run(["git"] + list(args), cwd=str(cwd), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, universal_newlines=True, timeout=GIT_TIMEOUT)
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


def clone_for(registry_path: Path, repo: str, environ) -> Path:
    """The local clone of `owner/repo`: the first folder that exists of the system whose `repositories` holds the bare
    name. `~` is read against `environ["HOME"]`."""
    bare = repo.split("/")[-1]
    try:
        systems = json.loads(Path(registry_path).read_text(encoding="utf-8")).get("systems") or []
    except (OSError, ValueError):
        raise GitError("the registry could not be read")
    home = (environ or {}).get("HOME") or str(Path.home())
    known = False
    for system in systems:
        if bare in (system.get("repositories") or []):
            known = True
            for folder in system.get("folders") or []:
                path = Path(home) / folder[2:] if folder.startswith("~/") else Path(folder)
                if path.is_dir():
                    return path
    raise GitError("no local clone of {} was found{}".format(
        bare, "" if known else " (the repository is not in the registry)"))


def owner_repo(clone: Path) -> str:
    """`owner/repo` from the clone's `origin` (https or ssh form, `.git` dropped)."""
    url = git(clone, "remote", "get-url", "origin")
    found = re.search(r"[:/]([^:/]+)/([^/]+?)(?:\.git)?/?$", url)
    if not found:
        raise GitError("origin is not an owner/repo address")
    return "{}/{}".format(found.group(1), found.group(2))


def slug(summary: str, limit: int = 40) -> str:
    """Lower case, every run of other characters becomes `-`, cut at a word end; `work` when nothing is left."""
    text = re.sub(r"[^a-z0-9]+", "-", (summary or "").lower()).strip("-")
    if len(text) > limit:
        if text[limit] == "-":
            text = text[:limit]
        else:
            cut = text[:limit].rfind("-")
            text = text[:cut] if cut > 0 else text[:limit]
    return text or "work"


def ticket_branches(clone: Path, key: str) -> List[str]:
    """Local and `origin` branches named `<KEY>-*`, each once, without `origin/`."""
    out = git(clone, "for-each-ref", "--format=%(refname)", "refs/heads/{}-*".format(key),
              "refs/remotes/origin/{}-*".format(key))
    names = []
    for ref in out.splitlines():
        name = re.sub(r"^refs/(?:heads|remotes/origin)/", "", ref.strip())
        if name and name not in names:
            names.append(name)
    return sorted(names)


def _worktree_branches(clone: Path) -> dict:
    """{resolved worktree path: branch} from `git worktree list`."""
    found, path = {}, None
    for line in git(clone, "worktree", "list", "--porcelain").splitlines():
        if line.startswith("worktree "):
            path = Path(line[9:]).resolve()
        elif line.startswith("branch ") and path is not None:
            found[path] = re.sub(r"^refs/heads/", "", line[7:])
    return found


def _has_ref(clone: Path, ref: str) -> bool:
    return bool(git(clone, "for-each-ref", "--format=%(refname)", ref))


def _exclude_worktrees(clone: Path) -> None:
    """Keep `.claude/worktrees/` out of the clone's `git status` through the clone's own exclude file (`.git/info`),
    which is local and never committed. A repository that already ignores the folder needs nothing."""
    entry = "/{}/{}/".format(*WORKTREES)
    exclude = Path(git(clone, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude"))
    try:
        text = exclude.read_text(encoding="utf-8") if exclude.exists() else ""
        if entry not in text.splitlines():
            exclude.parent.mkdir(parents=True, exist_ok=True)
            exclude.write_text(text + ("" if text.endswith("\n") or not text else "\n") + entry + "\n", encoding="utf-8")
    except OSError:
        pass   # best effort: a clone we cannot write to still gets its worktree


def add_worktree(clone: Path, branch: str, base: str) -> Path:
    """The worktree for `branch`, made when it is missing: from the local branch if there is one, else from
    `origin/<branch>`, else a new branch cut from `origin/<base>`. One that already exists is returned as it is."""
    path = Path(clone) / WORKTREES[0] / WORKTREES[1] / branch
    if _worktree_branches(clone).get(path.resolve()) == branch:
        return path
    git(clone, "worktree", "prune")
    git(clone, "fetch", "origin")
    _exclude_worktrees(clone)
    if _has_ref(clone, "refs/heads/" + branch):
        git(clone, "worktree", "add", str(path), branch)
    elif _has_ref(clone, "refs/remotes/origin/" + branch):
        git(clone, "worktree", "add", "--no-track", "-b", branch, str(path), "origin/" + branch)
    else:
        git(clone, "worktree", "add", "--no-track", "-b", branch, str(path), "origin/" + base)
    return path


def is_clean(worktree: Path) -> bool:
    return git(worktree, "status", "--porcelain") == ""


def unpushed(worktree: Path) -> int:
    return int(git(worktree, "rev-list", "--count", "HEAD", "--not", "--remotes") or 0)


def head(worktree: Path) -> str:
    return git(worktree, "rev-parse", "HEAD")


def ahead_of(worktree: Path, base: str) -> int:
    return int(git(worktree, "rev-list", "--count", "origin/{}..HEAD".format(base)) or 0)


def push(worktree: Path, branch: str) -> None:
    git(worktree, "push", "-u", "origin", branch)


def changed_files(worktree: Path, base: str) -> List[str]:
    return [line for line in git(worktree, "diff", "--name-only", "origin/{}...HEAD".format(base)).splitlines() if line]


def diff_stat(worktree: Path, base: str) -> str:
    return git(worktree, "diff", "--stat", "origin/{}...HEAD".format(base))


def added_lines(worktree: Path, base: str) -> List[Tuple[str, str]]:
    """(file, line) for every line the branch adds against `origin/<base>`, without the leading `+`."""
    out = git(worktree, "diff", "-U0", "--no-color", "origin/{}...HEAD".format(base))
    rows, current = [], ""
    for line in out.splitlines():
        if line.startswith("+++ "):
            current = line[4:].strip()
            current = current[2:] if current.startswith("b/") else ""   # "/dev/null": a deletion
        elif line.startswith("+") and current:
            rows.append((current, line[1:]))
    return rows


def remove_worktree(clone: Path, worktree: Path, branch: str, pushed_head: Optional[str] = None) -> Optional[str]:
    """Remove the worktree and the local branch. None when both are gone (also when they already were); otherwise the
    reason it refused, with nothing removed. It refuses a dirty worktree, one whose head is not `pushed_head` (when
    given), and one with unpushed commits (when `pushed_head` is not given)."""
    clone, worktree = Path(clone), Path(worktree)
    git(clone, "worktree", "prune")
    exists = worktree.exists()
    has_branch = _has_ref(clone, "refs/heads/" + branch)
    if not exists and not has_branch:
        return None
    if exists and not is_clean(worktree):
        return "the worktree has changes that are not committed"
    if has_branch:
        tip = git(clone, "rev-parse", "refs/heads/" + branch)
        if pushed_head is not None:
            if tip != pushed_head:
                return "the branch is not at the commit that was pushed"
        elif int(git(clone, "rev-list", "--count", "refs/heads/" + branch, "--not", "--remotes") or 0) > 0:
            return "the branch has commits that are not pushed"
    if exists:
        git(worktree, "status", "--short")   # fails loudly if it is not a worktree at all
        git(clone, "worktree", "remove", str(worktree))
    if has_branch:
        git(clone, "branch", "-D", branch)
    return None


def merges_for(registry_path: Path, repo: str) -> str:
    """`agent` when the registry system that holds the repository's bare name lets agents merge there; `josh`
    otherwise, an unknown repository (or an unreadable registry) included: the safe answer is the one that waits."""
    bare = repo.split("/")[-1]
    try:
        systems = json.loads(Path(registry_path).read_text(encoding="utf-8")).get("systems") or []
    except (OSError, ValueError):
        return "josh"
    for system in systems:
        if bare in (system.get("repositories") or []):
            return "agent" if system.get("merges") == "agent" else "josh"
    return "josh"
