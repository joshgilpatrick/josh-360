#!/usr/bin/env python3
"""The Josh 360 install script (JP-105). Safe to run any number of times.

    python3 laptop/install.py            plan, apply, print what changed
    python3 laptop/install.py --dry-run  plan only, change nothing
    python3 laptop/install.py --json     also print a one-line JSON summary last (the follow job reads it)

It runs in two passes. The plan pass looks at every step and changes nothing. If any step meets
something it does not expect, the script prints the problems and exits 3 with nothing changed.
Otherwise the apply pass makes the planned changes and prints them. A second run reports
"changed: 0".

It writes only inside JOSH360_HOME (default ~/.josh-360): every write goes through common.Lane.

Later tickets add their own steps to STEPS (the ledger step is JP-107's).
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Callable, List, Tuple

sys.dont_write_bytecode = True  # keep the laptop's copy clean
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (REPO_ROOT, Lane, Unexpected, dump_json, git, home, load_jobs, logs_dir,  # noqa: E402
                    now_utc, read_json, require_laptop_copy, state_dir)

HOOK_EVENTS = {
    "SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification",
    "Stop", "SubagentStop", "PreCompact", "PostCompact",
}

# A step's plan returns (actions, problems). Each action is (description, apply function).
Action = Tuple[str, Callable[[Lane], None]]
Plan = Tuple[List[Action], List[str]]


def step_home() -> Plan:
    actions: List[Action] = []
    problems: List[str] = []
    root = home()
    if root.is_symlink():
        return [], ["{} is a link; expected a real folder".format(root)]
    for folder in (root, state_dir(), logs_dir()):
        if folder.is_symlink():
            problems.append("{} is a link; expected a real folder".format(folder))
        elif folder.exists() and not folder.is_dir():
            problems.append("{} exists but is not a folder".format(folder))
        elif not folder.exists():
            actions.append(("create folder {}".format(folder), lambda lane, f=folder: lane.mkdir(f)))
    return actions, problems


def step_ledger() -> Plan:
    """JP-107: create the ledger from ledger/schema.sql, or apply the migrations it has not had."""
    sys.path.insert(0, str(REPO_ROOT))
    from ledger import db as ledger_db  # noqa: E402

    path = ledger_db.ledger_path()
    if path.is_symlink() or (path.exists() and not path.is_file()):
        return [], ["{} exists but is not a regular file".format(path)]
    if path.is_file():
        try:
            conn = ledger_db.sqlite3.connect("file:{}?mode=ro".format(path), uri=True)
            try:
                current = ledger_db.user_version(conn)
            finally:
                conn.close()
        except ledger_db.sqlite3.Error as e:
            return [], ["{} cannot be read: {}".format(path, e)]
        if current >= ledger_db.newest_version():
            return [], []

    def apply(lane: Lane) -> None:
        lane.check(path)
        lane.check(ledger_db.backups_dir())
        ledger_db.ensure(path, ledger_db.backups_dir(), now_utc())

    return [("create or migrate the ledger", apply)], []


def step_jobs() -> Plan:
    try:
        load_jobs(REPO_ROOT)
    except Unexpected as e:
        return [], ["jobs.yaml: {}".format(e)]
    return [], []


def step_hooks() -> Plan:
    problems: List[str] = []
    hooks = REPO_ROOT / "hooks"
    dispatch = hooks / "dispatch"
    if not (dispatch.is_file() and os.access(str(dispatch), os.X_OK)):
        problems.append("hooks/dispatch is missing or not executable")
    if hooks.is_dir():
        for entry in sorted(hooks.iterdir()):
            if entry.name in ("dispatch", "README.md"):
                continue
            if not entry.is_dir() or entry.name not in HOOK_EVENTS:
                problems.append("hooks/{} is not a known hook event folder".format(entry.name))
                continue
            for hook in sorted(entry.iterdir()):
                if hook.name == "README.md":
                    continue
                if not (hook.is_file() and os.access(str(hook), os.X_OK)):
                    problems.append("hooks/{}/{} is not an executable file".format(entry.name, hook.name))
    return [], problems


def step_installed_commit() -> Plan:
    result = git(["rev-parse", "HEAD"], REPO_ROOT, check=False)
    if result.returncode != 0:
        return [], ["{} is not a git checkout".format(REPO_ROOT)]
    commit = result.stdout.strip()
    path = state_dir() / "installed.json"
    current = read_json(path, {}) if path.is_file() else {}
    if current.get("commit") == commit:
        return [], []
    text = dump_json({"commit": commit})
    return [("record installed commit {}".format(commit[:12]),
             lambda lane: lane.write_text(path, text))], []


STEPS = [
    ("home folders", step_home),
    ("ledger", step_ledger),
    ("jobs file", step_jobs),
    ("hooks", step_hooks),
    ("installed commit", step_installed_commit),
]


def run(dry_run: bool = False) -> dict:
    plans = []
    problems: List[str] = []
    for name, plan in STEPS:
        actions, step_problems = plan()
        plans.append((name, actions))
        problems += ["{}: {}".format(name, p) for p in step_problems]
    if problems:
        return {"result": "failed", "changed": 0, "unchanged": 0, "problems": len(problems),
                "lines": ["problem   " + p for p in problems] + ["stopped: nothing was changed"]}

    lane = Lane()
    lines: List[str] = []
    changed = unchanged = 0
    for name, actions in plans:
        if not actions:
            unchanged += 1
            lines.append("unchanged {}".format(name))
            continue
        changed += 1
        for description, apply in actions:
            if not dry_run:
                apply(lane)
            lines.append("{} {}".format("would    " if dry_run else "changed  ", description))
    return {"result": "passed", "changed": changed, "unchanged": unchanged, "problems": 0, "lines": lines}


def main(argv: List[str]) -> int:
    dry_run = "--dry-run" in argv
    if not dry_run:
        try:
            require_laptop_copy()
        except Unexpected as e:
            print("install: stopped: {} (use --dry-run to preview from any clone)".format(e))
            return 3
    summary = run(dry_run=dry_run)
    for line in summary["lines"]:
        print(line)
    print("install: {} (changed: {}, unchanged: {}, problems: {})".format(
        summary["result"], summary["changed"], summary["unchanged"], summary["problems"]))
    if "--json" in argv:
        print(json.dumps({k: summary[k] for k in ("result", "changed", "unchanged", "problems")}))
    return 0 if summary["result"] == "passed" else 3


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
