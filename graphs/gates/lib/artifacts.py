"""Where a non-development deliverable may live (JP-104 spec, "Deliverables and where they live"; JP-123).

Python 3.9, standard library only. A deliverable, its evidence file and its saved queries sit flat in
`<artifacts root>/<system>/`, outside every repository and worktree, each file name starting with the ticket key.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

DEFAULT_ROOT = Path("~/Development/active/.artifacts")


def artifacts_root(environ=None) -> Path:
    env = os.environ if environ is None else environ
    return Path(env.get("JOSH360_ARTIFACTS_ROOT") or DEFAULT_ROOT).expanduser()


def system_folder(root: Path, system: Optional[str]) -> Path:
    """The folder for a system: its name, or josh-projects when the ticket has none."""
    name = (system or "").strip()
    return root / (name if name and name != "none" else "josh-projects")


def problem_with(raw: Optional[str], root: Path, key: str) -> Optional[str]:
    """Why `raw` is not an acceptable artifact file for ticket `key`, or None when it is. Never quotes file content."""
    if not raw or not raw.strip():
        return "no path given"
    path = Path(raw.strip()).expanduser()
    if not path.is_absolute():
        return "the path is not absolute"
    if ".." in path.parts:
        return "the path goes through '..'"
    try:
        real = path.resolve(strict=True)
        real_root = root.resolve(strict=True)
    except (OSError, RuntimeError):
        return "the file does not exist"
    if not real.is_file():
        return "the path is not a file"
    folder = real.parent
    if folder.parent != real_root or folder == real_root:
        return "the file is not directly inside a folder of the artifacts folder"
    if not real.name.startswith(key):
        return "the file name does not start with the ticket key"
    for ancestor in (folder, real_root):
        if (ancestor / ".git").exists():
            return "the file is inside a repository"
    if _inside_worktree(real):
        return "the file is inside a worktree"
    return None


def _inside_worktree(path: Path) -> bool:
    parts = path.parts
    return any(parts[i] == ".claude" and parts[i + 1] == "worktrees" for i in range(len(parts) - 1))


def query_file_problem(ref: str, folder: Path, key: str) -> Optional[str]:
    """A saved query source: its ref must be a file in `folder` (a bare name, or a path into it)."""
    candidate = Path(ref).expanduser()
    if ".." in candidate.parts:
        return "a saved query path goes through '..'"
    full = candidate if candidate.is_absolute() else folder / candidate
    try:
        real = full.resolve(strict=True)
    except (OSError, RuntimeError):
        return "a saved query file does not exist"
    if not real.is_file() or real.parent != folder.resolve():
        return "a saved query file is not in the deliverable's folder"
    return None
