"""Running a spec's checks, and writing what they found (JP-115). Python 3.9, standard library only.

A phase's checks are shell commands a model wrote, so they run with `/bin/bash -c` in the worktree, in their own process
group, with the ticket system's credentials taken out of the environment, and each is stopped when the gate's time
budget is spent: a hung check is a failed check, never a stopped run. The result of a check carries its last lines of
output for the builder's feedback file, but the evidence file never holds output.
"""
from __future__ import annotations

import os
import re
import signal
import subprocess
import time
from fnmatch import fnmatch
from pathlib import Path
from typing import Dict, List, NamedTuple, Optional

from lib import dev_git, feedback

SECRET_NAMES = ("JOSH360_JIRA_TOKEN", "JOSH360_JIRA_EMAIL", "ACTION_AGENT_JIRA_EMAIL", "ACTION_TRIAGE_JIRA_TOKEN")
TAIL_LINES = 20
TAIL_CHARS = 2000
PLACEHOLDER = re.compile(
    r"TODO|FIXME|XXX|NotImplemented|not implemented|placeholder|lorem ipsum|@pytest\.mark\.skip|\.skip\(|xit\(|"
    r"assert True|raise NotImplementedError")
FEEDBACK_FIELDS = ("command", "result", "output_tail")


class CheckResult(NamedTuple):
    phase: str
    number: int
    command: str
    exit_code: Optional[int]    # None: timed out, or not run for lack of time
    seconds: float
    tail: str
    extra: bool


def clean_env(environ) -> Dict[str, str]:
    """The environment a check sees: no Jira credentials and no gate inputs."""
    return {k: v for k, v in dict(environ).items() if k not in SECRET_NAMES and not k.startswith("GRAPH_INPUT_")}


def budget(environ) -> int:
    """Seconds the checks may take together: the gate's time limit less a minute for the rest of the gate."""
    try:
        limit = int((environ or {}).get("JOSH360_GATE_TIMEOUT") or 600)
    except ValueError:
        limit = 600
    return max(limit - 60, 5)


def _tail(text: str) -> str:
    lines = (text or "").rstrip().splitlines()[-TAIL_LINES:]
    return "\n".join(lines)[-TAIL_CHARS:]


def _run_one(command: str, worktree: Path, env: Dict[str, str], seconds: float):
    """(exit code or None, seconds taken, tail of the output)."""
    started = time.monotonic()
    if seconds <= 0:
        return None, 0.0, "not run: the time budget was spent"
    try:
        proc = subprocess.Popen(["/bin/bash", "-c", command], cwd=str(worktree), env=env, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, universal_newlines=True,
                                errors="replace", start_new_session=True)
    except OSError as exc:
        return 127, 0.0, "could not start: {}".format(exc.__class__.__name__)
    try:
        out, _ = proc.communicate(timeout=seconds)
        return proc.returncode, time.monotonic() - started, _tail(out)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)   # the whole group: a hung child must not outlive the gate
        except (OSError, ProcessLookupError):
            pass
        try:
            out, _ = proc.communicate(timeout=5)
        except subprocess.SubprocessError:
            out = ""
        return None, time.monotonic() - started, _tail(out)


def run_all(spec: dict, state: dict, worktree: Path, environ, seconds: int) -> List[CheckResult]:
    """Each phase's `checks`, then its `extra_checks` from the state file. One command string runs once; every phase
    that names it gets the same result."""
    env = clean_env(environ)
    deadline = time.monotonic() + seconds
    done: Dict[str, tuple] = {}
    results: List[CheckResult] = []
    for phase in spec.get("phases") or []:
        pid = phase.get("id")
        extras = list(((state.get("phases") or {}).get(pid) or {}).get("extra_checks") or [])
        commands = [(c, False) for c in phase.get("checks") or []] + [(c, True) for c in extras]
        for number, (command, extra) in enumerate(commands, 1):
            if command not in done:
                done[command] = _run_one(command, worktree, env, deadline - time.monotonic())
            code, took, tail = done[command]
            results.append(CheckResult(pid, number, command, code, took, tail, extra))
    return results


def failing_phases(results: List[CheckResult]) -> List[str]:
    bad: List[str] = []
    for r in results:
        if r.exit_code != 0 and r.phase not in bad:
            bad.append(r.phase)
    return bad


def _result_word(r: CheckResult) -> str:
    return "timed out" if r.exit_code is None else "exit {}".format(r.exit_code)


def write_feedback(work_dir: Path, results: List[CheckResult]) -> None:
    """feedback/<phase>.md for each failing phase (replacing an older file); a phase that passes loses its file."""
    folder = Path(work_dir) / "feedback"
    folder.mkdir(parents=True, exist_ok=True)
    for pid in list(dict.fromkeys(r.phase for r in results)):
        target = folder / "{}.md".format(pid)
        rows = [{"command": r.command, "result": _result_word(r), "output_tail": r.tail}
                for r in results if r.phase == pid and r.exit_code != 0]
        if rows:
            target.write_text(feedback.feedback_text(
                "Failed checks for phase {}".format(pid),
                "Checks that did not pass on the last run, with the end of their output (contract feedback).",
                rows, FEEDBACK_FIELDS), encoding="utf-8")
        elif target.exists():
            target.unlink()


def _names_file(entry: str, name: str) -> bool:
    return name == entry or (entry.endswith("/") and name.startswith(entry)) or fnmatch(name, entry)


def write_evidence(work_dir: Path, key: str, base: str, worktree: Path, results: List[CheckResult],
                   spec: Optional[dict] = None) -> Path:
    """work/evidence.md: the front block lib/evidence.py reads, then Checks, Files changed, Placeholder lines and Files
    no phase names. No check output. The last two sections are reports and change no outcome."""
    passed = sum(1 for r in results if r.exit_code == 0)
    lines = ["---", "ticket: {}".format(key), "kind: development", "base: {}".format(base),
             "head: {}".format(dev_git.head(worktree)), "checks_total: {}".format(len(results)),
             "checks_passed: {}".format(passed), "---", "", "## Checks", ""]
    for r in results:
        lines.append("- {} check {}{}: `{}` → {} ({:.1f} s)".format(
            r.phase, r.number, " (added by review)" if r.extra else "", r.command, _result_word(r), r.seconds))
    if not results:
        lines.append("- no checks ran")
    lines += ["", "## Files changed", "", "```", dev_git.diff_stat(worktree, base) or "no changes", "```", "",
              "## Placeholder lines", ""]
    hits = [(f, t) for f, t in dev_git.added_lines(worktree, base) if PLACEHOLDER.search(t)]
    for f, t in hits[:50]:
        lines.append("- {}: `{}`".format(f, t.strip()[:160]))
    lines.append("- none" if not hits else ("- ({} more not shown)".format(len(hits) - 50) if len(hits) > 50 else ""))
    lines += ["", "## Files no phase names", ""]
    if spec is None:
        lines.append("- not checked")
    else:
        named = [f for p in spec.get("phases") or [] for f in p.get("files") or [] if isinstance(f, str)]
        loose = [f for f in dev_git.changed_files(worktree, base) if not any(_names_file(e, f) for e in named)]
        lines += ["- {}".format(f) for f in loose] or ["- none"]
    path = Path(work_dir) / "evidence.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(l for l in lines) + "\n", encoding="utf-8")
    return path
