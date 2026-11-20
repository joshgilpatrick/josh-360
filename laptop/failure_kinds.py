"""The three kinds of failure, and the one rule for sorting a failure into a kind (JP-183).

Python 3.9, standard library only. The graph runner, the walker and the laptop job runner all sort a failure here, so a
retry or a run cap is spent only on a failure that could change. The rule is in graphs/CONVENTION.md, "The run cap".

    needs-fix   Won't fix itself: a bad model or effort name, a missing CLI, credential or folder, bad input. Stop at
                once, with no retries, name the cause and the fix. Uses no run of the step's tier cap.
    may-clear   Might fix itself: Agent Manager not running, a timeout, a rate limit, a network error, a refusal with
                no explanation. Retry with growing gaps; never counts against the cap; when the retries run out the run
                is "stuck", not abandoned, so a plain resume works.
    ran         The model ran and the step failed: a bad result, the time cap, a session that ended or went quiet
                without a result. The only kind that counts against the tier's run cap.

A reason this module does not know is may-clear, so nothing is stopped for good by guesswork.
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path
from typing import Dict, Iterable, List, Optional

NEEDS_FIX = "needs-fix"
MAY_CLEAR = "may-clear"
RAN = "ran"
KINDS = (NEEDS_FIX, MAY_CLEAR, RAN)

# Every reason code a part of Josh 360 gives a failure, and its kind. A code is one fixed word, never text from a run.
REASONS: Dict[str, str] = {
    # The Agent Manager binding's refusals (graphs/bindings/agent-manager/binding.py).
    "no-cli": NEEDS_FIX, "bad-model": NEEDS_FIX, "bad-effort": NEEDS_FIX, "no-folder": NEEDS_FIX,
    "not-running": MAY_CLEAR, "rate-limited": MAY_CLEAR, "network": MAY_CLEAR, "timeout": MAY_CLEAR,
    "group": MAY_CLEAR, "refused": MAY_CLEAR, "no-id": MAY_CLEAR,
    # How the runner ends an attempt (graphs/runner/runner_lib/advance.py). `never-started` and `gone-before-start` are
    # sessions that never linked to their run, so no model ran as far as the runner can tell.
    "never-started": MAY_CLEAR, "gone-before-start": MAY_CLEAR,
    "bad-result": RAN, "time-cap": RAN, "session-gone": RAN, "rested-without-result": RAN,
    # A laptop job (laptop/run_jobs.py).
    "job-needs-fix": NEEDS_FIX, "job-code": NEEDS_FIX, "job-timed-out": MAY_CLEAR, "job-failed": MAY_CLEAR,
}

# What to do about each reason that won't fix itself: the line a stop notice and doctor print.
FIXES: Dict[str, str] = {
    "no-cli": "install the agent-manager or claude command line (or set JOSH360_AM_BIN / JOSH360_CLAUDE_BIN)",
    "bad-model": "name a model Agent Manager lists: fix graphs/tiers.yaml or the `models` map in "
                 "graphs/bindings/agent-manager/binding.json, then rerun graphs/tools/compile_graphs.py",
    "bad-effort": "name an effort Agent Manager lists: fix the effort in graphs/tiers.yaml, then rerun "
                  "graphs/tools/compile_graphs.py",
    "no-folder": "make the step's folder exist again (its worktree or work folder)",
    "job-needs-fix": "do what the job's last line asks",
    "job-code": "fix the job's code (an import or syntax error); the next merge to main runs it again",
}

# A job says "this won't fix itself" by exiting 78 (EX_CONFIG in sysexits.h) after printing `needs-fix: <why>`.
EXIT_NEEDS_FIX = 78
REASON_LIMIT = 200
# The tail of a Python traceback that only a code change can clear.
CODE_ERRORS = ("SyntaxError", "IndentationError", "ModuleNotFoundError", "ImportError", "can't open file")


def kind_of(reason: Optional[str]) -> str:
    """The kind of a reason code. An unknown code is may-clear."""
    return REASONS.get(str(reason or ""), MAY_CLEAR)


def counts_against_cap(reason: Optional[str]) -> bool:
    """Only a failure where the model ran uses one of the tier's runs."""
    return kind_of(reason) == RAN


def fix_for(reason: Optional[str]) -> str:
    return FIXES.get(str(reason or ""), "")


def gap(tries: int, gaps: Iterable[float]) -> float:
    """How long to wait before try number `tries + 1`, after `tries` failures: the gaps grow, and the last one repeats."""
    steps: List[float] = [float(g) for g in gaps] or [0.0]
    return steps[min(max(tries, 1), len(steps)) - 1]


def _screen(text: str, phi: bool) -> List[str]:
    """The shared patient-data screen (graphs/gates/lib/patient_data.py), loaded from this checkout."""
    gates = str(Path(__file__).resolve().parent.parent / "graphs" / "gates")
    if gates not in sys.path:
        sys.path.insert(0, gates)
    from lib import patient_data  # noqa: E402
    return patient_data.scan(text, None, phi, external=True)


def short(text: Optional[str], phi: bool = False, limit: int = REASON_LIMIT) -> str:
    """A tool's message made fit for a log line: one line, about `limit` characters, after the patient-data screen.
    Text the screen flags is replaced by the kinds it found, never shown."""
    one = " ".join(str(text or "").split())
    if not one:
        return ""
    problems = _screen(one, phi)
    if problems:
        return "(message held back: the patient-data screen found {})".format(", ".join(problems))
    return one if len(one) <= limit else one[:limit - 3] + "..."


def job_reason(code: int, stderr: str) -> str:
    """The reason code of a failed laptop job, from its exit code and what it printed."""
    if code == EXIT_NEEDS_FIX:
        return "job-needs-fix"
    if code == 124:
        return "job-timed-out"
    tail = [line for line in str(stderr or "").splitlines() if line.strip()]
    last = tail[-1] if tail else ""
    if any(word in last for word in CODE_ERRORS):
        return "job-code"
    return "job-failed"


def last_line(stderr: str) -> str:
    """The line a job's failure is told by: its `needs-fix:` line when it printed one, else its last line."""
    lines = [line.strip() for line in str(stderr or "").splitlines() if line.strip()]
    for line in reversed(lines):
        if line.startswith("needs-fix:"):
            return line[len("needs-fix:"):].strip()
    return lines[-1] if lines else ""


def repo_commit(root: Path) -> str:
    """The commit the checkout at `root` is on, read from .git without running git; "" when it cannot be read."""
    git = Path(root) / ".git"
    try:
        head = (git / "HEAD").read_text(encoding="utf-8").strip()
        if not head.startswith("ref: "):
            return head
        ref = head[len("ref: "):]
        loose = git / ref
        if loose.is_file():
            return loose.read_text(encoding="utf-8").strip()
        for line in (git / "packed-refs").read_text(encoding="utf-8").splitlines():
            if line.endswith(" " + ref):
                return line.split(" ", 1)[0]
    except OSError:
        pass
    return ""


def fingerprint(parts: dict) -> str:
    """A short hash of what a failure that needs a fix depended on. When it changes, the fix may have landed."""
    text = json.dumps(parts, sort_keys=True, default=str)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def file_hash(path: Path) -> str:
    try:
        return hashlib.sha256(Path(path).read_bytes()).hexdigest()[:16]
    except OSError:
        return "missing"


def needs_fix(message: str) -> None:
    """For a job: say why it cannot succeed until something is fixed, and exit 78. Never returns."""
    sys.stderr.write("needs-fix: {}\n".format(" ".join(str(message).split())))
    sys.exit(EXIT_NEEDS_FIX)
