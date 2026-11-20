"""Where the runner keeps things, its numbers, and the two switches it checks before it starts a session (JP-117).

Python 3.9, standard library only. Settings come from `graphs/runner/settings.json` (or the file named by
JOSH360_RUNNER_SETTINGS) laid over DEFAULTS, so every number the runner uses is in one visible file.
"""
from __future__ import annotations

import datetime
import json
import os
import sys
from pathlib import Path
from typing import Optional

HERE = Path(__file__).resolve().parent.parent          # graphs/runner
ROOT = HERE.parent.parent                              # the repository root
for _p in (str(ROOT), str(ROOT / "graphs" / "tools")):
    if _p not in sys.path:
        sys.path.insert(0, _p)
from ledger import _repo  # noqa: E402,F401  (also puts graphs/gates on sys.path)
from laptop import common  # noqa: E402

DEFAULTS = {
    "host": "job", "session_limit": 2, "turn_cap": 200, "reflect_every": 40,
    "time_cap_seconds": 10800, "time_cap_grace_seconds": 900, "link_timeout_seconds": 600,
    "rest_timeout_seconds": 600, "advance_limit_seconds": 7200, "spawn_tries": 5,
    "spawn_gaps_seconds": [300, 900, 1800, 3600],   # JP-183: the waits between tries of a spawn that may clear
    "tick_seconds": 300, "heartbeat_stale_seconds": 600, "wait_flag_days": 7,
    "result_settle_seconds": 60, "archive_finished_sessions": True, "ended_runs_days": 14, "done_keep_days": 7,
    "wait_flag_exempt": ["validation.watch"],   # "<graph>.<step>" waits that are meant to last: never listed as stuck
}
EVENTS = ("UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop")


def settings() -> dict:
    """DEFAULTS overlaid by the settings file. A file that is not a JSON object raises ValueError."""
    merged = dict(DEFAULTS)
    path = Path(os.environ.get("JOSH360_RUNNER_SETTINGS") or (HERE / "settings.json"))
    if path.is_file():
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
        except ValueError as err:
            raise ValueError("{} is not valid JSON: {}".format(path, err))
        if not isinstance(doc, dict):
            raise ValueError("{} must hold a JSON object".format(path))
        merged.update(doc)
    return merged


def graphs_root(root: Optional[Path] = None) -> Optional[Path]:
    """The graphs folder to hand the walker: `root`, else JOSH360_GRAPHS_ROOT (tests use another folder, and the detached
    `advance` the tick starts has to find the same one), else None, which is the walker's own default."""
    if root:
        return Path(root)
    named = os.environ.get("JOSH360_GRAPHS_ROOT")
    return Path(named) if named else None


def state_dir() -> Path:
    return common.state_dir() / "runner"


def log_dir() -> Path:
    return common.logs_dir() / "runner"


def off_file() -> Path:
    return common.state_dir() / "runner-off"


def is_off() -> bool:
    return off_file().exists()


def log(line: str) -> None:
    """One line in runner.log, with the UTC time. Ids, step names and outcomes only (never ticket text)."""
    try:
        log_dir().mkdir(parents=True, exist_ok=True)
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        with open(str(log_dir() / "runner.log"), "a", encoding="utf-8") as handle:
            handle.write("{} {}\n".format(stamp, line))
    except OSError:
        pass


def run_log(run_id: str) -> Path:
    return log_dir() / "run-{}.log".format(run_id)


def claude_settings_path(environ: Optional[dict] = None) -> Path:
    env = os.environ if environ is None else environ
    return Path(env.get("JOSH360_CLAUDE_SETTINGS") or os.path.join(os.path.expanduser("~"), ".claude", "settings.json"))


def rails_loaded(environ: Optional[dict] = None) -> bool:
    """True only when Claude Code's settings name `hooks/dispatch` under each of the four events the rails use."""
    try:
        doc = json.loads(claude_settings_path(environ).read_text(encoding="utf-8"))
        hooks = doc["hooks"]
        for event in EVENTS:
            found = False
            for group in hooks.get(event) or []:
                for hook in (group.get("hooks") or []):
                    if "hooks/dispatch" in str(hook.get("command") or ""):
                        found = True
            if not found:
                return False
        return True
    except (OSError, ValueError, KeyError, AttributeError, TypeError):
        return False
