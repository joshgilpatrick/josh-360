"""The few Agent Manager calls the console and its keep-alive job make (JP-185). Python 3.9, standard library only.

Like the graph runner's binding, every call runs with Claude Code's folder first on the PATH, because a laptop job's
PATH has no `~/.local/bin`. JOSH360_AM_BIN names the executable (tests point it at a fake).
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from typing import Dict, List, Optional, Tuple

SEARCH_DIRS = (".local/bin", "bin", ".cargo/bin")
SYSTEM_DIRS = ("/opt/homebrew/bin", "/usr/local/bin")
TIMEOUT = 60


def find(name: str, env_var: str) -> Optional[str]:
    named = os.environ.get(env_var)
    if named:
        return named if os.access(named, os.X_OK) else None
    found = shutil.which(name)
    if found:
        return found
    home = os.path.expanduser("~")
    for folder in [os.path.join(home, d) for d in SEARCH_DIRS] + list(SYSTEM_DIRS):
        candidate = os.path.join(folder, name)
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def _env() -> Dict[str, str]:
    env = dict(os.environ)
    claude = find("claude", "JOSH360_CLAUDE_BIN")
    if claude:
        env["PATH"] = os.path.dirname(claude) + os.pathsep + env.get("PATH", "")
    return env


def run(args: List[str], timeout: int = TIMEOUT) -> Tuple[int, str, str]:
    """(exit code, stdout, stderr). Exit 127 when there is no agent-manager; 124 when it timed out."""
    binary = find("agent-manager", "JOSH360_AM_BIN")
    if not binary:
        return 127, "", "agent-manager not found"
    try:
        done = subprocess.run([binary] + args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, universal_newlines=True, timeout=timeout, env=_env())
    except subprocess.TimeoutExpired:
        return 124, "", "timed out after {}s".format(timeout)
    except OSError as err:
        return 126, "", type(err).__name__
    return done.returncode, done.stdout, done.stderr


def run_json(args: List[str], timeout: int = TIMEOUT):
    """The parsed JSON answer, or raise ValueError with a short reason (a failed call or a non-JSON answer)."""
    code, out, err = run(args, timeout)
    if code != 0:
        raise ValueError("exit {}: {}".format(code, (err or out).strip()[:160]))
    try:
        return json.loads(out)
    except ValueError:
        raise ValueError("not JSON: {}".format(out.strip()[:160]))


def rename(name: str) -> str:
    """Name the session or terminal this runs in (Agent Manager reads which one from the environment or the tmux
    pane). Returns a short word for the banner; never raises."""
    code, out, err = run(["rename", name], timeout=15)
    if code == 0:
        return "named {}".format(name)
    return "not renamed ({})".format((err or out).strip()[:80] or "exit {}".format(code))
