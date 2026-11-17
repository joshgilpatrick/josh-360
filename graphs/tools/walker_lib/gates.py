"""Run gate scripts and the three ticket effects. Standard library only.

A gate script is gates/<name>.py or .sh. It reads GRAPH_INPUT_<NAME> variables and prints one JSON line
{"outcome", "outputs", "summary"} (graphs/CONVENTION.md, "Gate scripts"). Only the walker runs one, and only a gate
script (never a role session) is given Jira credentials. Ticket effects (move the status, set the flag, post a
comment) are scripts too, with fixed command lines, so the walker holds no Jira code of its own.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Dict, List, NamedTuple, Optional, Tuple

KEYCHAIN_ITEM = "jira-claude-api-key"
GATE_TIMEOUT = int(os.environ.get("JOSH360_GATE_TIMEOUT", "600"))
EFFECT_TIMEOUT = 120


class GateResult(NamedTuple):
    outcome: Optional[str]
    outputs: Dict[str, object]
    summary: Optional[str]
    error: Optional[str]


def find_script(root: Path, name: str) -> Optional[Path]:
    for suffix in (".py", ".sh"):
        path = root / "gates" / (name + suffix)
        if path.is_file():
            return path
    return None


def jira_env() -> Dict[str, str]:
    """Credentials for gate scripts: the environment first, then (on a Mac) the keychain item."""
    email = os.environ.get("JOSH360_JIRA_EMAIL") or os.environ.get("ACTION_AGENT_JIRA_EMAIL")
    token = os.environ.get("JOSH360_JIRA_TOKEN")
    if not token and sys.platform == "darwin":
        try:
            out = subprocess.run(["/usr/bin/security", "find-generic-password", "-s", KEYCHAIN_ITEM, "-w"],
                                 stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, universal_newlines=True, timeout=20)
            token = out.stdout.strip() if out.returncode == 0 else None
        except (OSError, subprocess.SubprocessError):
            token = None
    found = {}
    if email:
        found["JOSH360_JIRA_EMAIL"] = email
    if token:
        found["JOSH360_JIRA_TOKEN"] = token
    return found


def _stringify(value: object) -> str:
    return value if isinstance(value, str) else json.dumps(value)


def gate_env(values: Dict[str, object], names: List[str], run_id: str, runs_dir: str, ticket: Optional[str],
             target_status: Optional[str]) -> Dict[str, str]:
    env = dict(os.environ)
    env.update(jira_env())
    for name in names:
        if name in values:
            env["GRAPH_INPUT_" + name.upper()] = _stringify(values[name])
    env["JOSH360_RUN_ID"] = run_id
    env["JOSH360_RUNS"] = runs_dir
    if ticket:
        env["JOSH360_TICKET_KEY"] = ticket
        env.setdefault("GRAPH_INPUT_TICKET_KEY", ticket)
    if target_status:
        env["GRAPH_INPUT_TARGET_STATUS"] = target_status
    return env


def _command(script: Path) -> List[str]:
    return [sys.executable, str(script)] if script.suffix == ".py" else ["bash", str(script)]


def run_gate(root: Path, name: str, env: Dict[str, str], cwd: Path, outcomes: Optional[List[str]]) -> GateResult:
    """Run one gate. Anything but a declared outcome on one JSON line is an error; the walker never retries it."""
    script = find_script(root, name)
    if script is None:
        return GateResult(None, {}, None, "gate script '{}' is missing".format(name))
    try:
        done = subprocess.run(_command(script), env=env, cwd=str(cwd), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              universal_newlines=True, timeout=GATE_TIMEOUT)
    except subprocess.TimeoutExpired:
        return GateResult(None, {}, None, "gate '{}' timed out after {} s".format(name, GATE_TIMEOUT))
    except OSError as exc:
        return GateResult(None, {}, None, "gate '{}' could not start: {}".format(name, exc))
    if done.returncode != 0:
        first = (done.stderr or done.stdout or "no output").strip().splitlines()[:1] or ["no output"]
        return GateResult(None, {}, None, "gate '{}' failed ({}): {}".format(name, done.returncode, first[0][:160]))
    lines = [ln for ln in done.stdout.splitlines() if ln.strip()]
    try:
        doc = json.loads(lines[-1])
        outcome = doc["outcome"]
    except (IndexError, ValueError, KeyError, TypeError):
        return GateResult(None, {}, None, "gate '{}' printed no outcome as one line of JSON".format(name))
    if not isinstance(outcome, str) or (outcomes is not None and outcome not in outcomes):
        return GateResult(None, {}, None, "gate '{}' printed the outcome '{}', which the step does not declare".format(
            name, str(outcome)[:40]))
    outputs = doc.get("outputs") or {}
    summary = doc.get("summary")
    return GateResult(outcome, outputs if isinstance(outputs, dict) else {},
                      summary if isinstance(summary, str) else None, None)


def _effect(argv: List[str], env: Dict[str, str]) -> Tuple[bool, str]:
    try:
        done = subprocess.run(argv, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True,
                              timeout=EFFECT_TIMEOUT)
    except (OSError, subprocess.SubprocessError) as exc:
        return False, str(exc)[:160]
    if done.returncode != 0:
        first = (done.stderr or done.stdout or "no output").strip().splitlines()[:1] or ["no output"]
        return False, first[0][:160]
    return True, ""


def move_status(root: Path, ticket: str, status: str, env: Dict[str, str], cwd: Path) -> Tuple[bool, str]:
    """Move the ticket to the status of the step's stretch, through the shared `move-ticket` gate script."""
    env = dict(env, GRAPH_INPUT_TICKET_KEY=ticket, GRAPH_INPUT_TARGET_STATUS=status, JOSH360_TICKET_KEY=ticket)
    result = run_gate(root, "move-ticket", env, cwd, ["moved"])
    return (result.error is None), (result.error or "")


def set_flag(root: Path, ticket: str, on: bool, env: Dict[str, str]) -> Tuple[bool, str]:
    script = find_script(root, "set-flag")
    if script is None:
        return False, "gate script 'set-flag' is missing"
    return _effect(_command(script) + ["--ticket", ticket, "--on" if on else "--off"], env)


def post_comment(root: Path, ticket: str, body_file: Path, env: Dict[str, str]) -> Tuple[bool, str]:
    script = find_script(root, "post-comment")
    if script is None:
        return False, "gate script 'post-comment' is missing"
    return _effect(_command(script) + ["--ticket", ticket, "--body-file", str(body_file)], env)
