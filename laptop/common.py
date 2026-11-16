"""Shared pieces of the laptop side of Josh 360 (JP-105).

Runs on the laptop's /usr/bin/python3 (3.9) with the standard library only.

- Paths: everything Josh 360 owns on the laptop sits under JOSH360_HOME (default ~/.josh-360).
- Lane: the one guard every write goes through. It refuses any path outside JOSH360_HOME.
- Jobs file: a strict reader for jobs.yaml. It accepts only the small shape the file uses and
  stops on anything else, so a typo never turns into a job that silently does the wrong thing.
"""
from __future__ import annotations

import datetime
import json
import os
import re
import subprocess
from pathlib import Path
from typing import Dict, List, Optional

REPO_ROOT = Path(__file__).resolve().parent.parent
STATUS_BRANCH = "laptop-status"
PAUSE_BRANCH = "laptop-pause"
MAIN_BRANCH = "main"


class Unexpected(Exception):
    """Something the code does not expect. The caller stops and changes nothing more."""


def home() -> Path:
    raw = os.environ.get("JOSH360_HOME") or os.path.join(os.path.expanduser("~"), ".josh-360")
    return Path(raw).absolute()


def state_dir() -> Path:
    return home() / "state"


def logs_dir() -> Path:
    return home() / "logs"


def pause_file() -> Path:
    return home() / "PAUSED"


def now_utc() -> str:
    return datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def laptop_copy() -> Path:
    return home() / "repo"


def require_laptop_copy() -> None:
    """follow, run_jobs and a real install act on the copy they run from. They only ever run from the
    laptop's own copy, so a clone Josh works in is never moved or recorded as installed."""
    if REPO_ROOT.resolve() != laptop_copy().resolve():
        raise Unexpected("this runs only from the laptop's copy at {}, not from {}".format(laptop_copy(), REPO_ROOT))


class Lane:
    """Every write by the install script and the runner goes through here."""

    def __init__(self, root: Optional[Path] = None) -> None:
        self.root = (root or home()).absolute()

    def check(self, path: Path) -> Path:
        path = Path(os.path.abspath(str(path)))
        if path != self.root and self.root not in path.parents:
            raise Unexpected("refused to write outside {}: {}".format(self.root, path))
        return path

    def mkdir(self, path: Path) -> None:
        self.check(path).mkdir(parents=True, exist_ok=True)

    def write_text(self, path: Path, text: str) -> None:
        path = self.check(path)
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(text, encoding="utf-8")
        os.replace(str(tmp), str(path))

    def append_text(self, path: Path, text: str, keep_bytes: int = 1_000_000) -> None:
        path = self.check(path)
        if path.exists() and path.stat().st_size > keep_bytes:
            os.replace(str(path), str(path.with_name(path.name + ".1")))
        with path.open("a", encoding="utf-8") as f:
            f.write(text)


def read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def dump_json(data) -> str:
    return json.dumps(data, indent=2, sort_keys=True) + "\n"


def git(args: List[str], cwd: Path, check: bool = True, env: Optional[Dict[str, str]] = None,
        input_text: Optional[str] = None) -> subprocess.CompletedProcess:
    """Run git with Josh's own hooks switched off, so nothing of his runs inside a laptop job."""
    full_env = dict(os.environ)
    full_env.update(env or {})
    full_env["GIT_TERMINAL_PROMPT"] = "0"
    result = subprocess.run(
        ["git", "-c", "core.hooksPath=/dev/null"] + args,
        cwd=str(cwd), env=full_env, input=input_text,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True,
    )
    if check and result.returncode != 0:
        raise Unexpected("git {} failed: {}".format(args[0], result.stderr.strip()[:300]))
    return result


# ---------------------------------------------------------------------------------------------
# jobs.yaml

JOB_KEYS = {"id", "run", "every", "description", "timeout", "report"}
REQUIRED_KEYS = {"id", "run", "every"}
ID_RE = re.compile(r"^[a-z][a-z0-9-]{0,39}$")
EVERY_RE = re.compile(r"^(\d+)([mhd])$")
UNIT_SECONDS = {"m": 60, "h": 3600, "d": 86400}
DEFAULT_TIMEOUT = 15 * 60


def parse_every(text: str) -> Optional[int]:
    """Seconds between runs, or None for "once"."""
    if text == "once":
        return None
    m = EVERY_RE.match(text)
    if not m or int(m.group(1)) == 0:
        raise Unexpected("every must be like 5m, 1h, 1d or once, not {!r}".format(text))
    return int(m.group(1)) * UNIT_SECONDS[m.group(2)]


def _scalar(raw: str, where: str) -> str:
    raw = raw.strip()
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "\"'":
        return raw[1:-1]
    if raw[:1] in "[{&*!|>%@`\"'" or " #" in raw:
        raise Unexpected("{}: only plain or quoted text is allowed here".format(where))
    return raw


def parse_jobs_text(text: str) -> List[Dict[str, str]]:
    jobs: List[Dict[str, str]] = []
    seen_header = False
    current: Optional[Dict[str, str]] = None
    for n, line in enumerate(text.splitlines(), 1):
        where = "jobs.yaml line {}".format(n)
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if "\t" in line:
            raise Unexpected("{}: tabs are not allowed".format(where))
        if not seen_header:
            if line.rstrip() != "jobs:":
                raise Unexpected("{}: the file must start with 'jobs:'".format(where))
            seen_header = True
            continue
        if line.startswith("  - "):
            current = {}
            jobs.append(current)
            body = line[4:]
        elif line.startswith("    ") and not line.startswith("     ") and current is not None:
            body = line[4:]
        else:
            raise Unexpected("{}: expected '  - key: value' or '    key: value'".format(where))
        key, sep, value = body.partition(":")
        key = key.strip()
        if not sep or key not in JOB_KEYS:
            raise Unexpected("{}: unknown key {!r}".format(where, key))
        if key in current:
            raise Unexpected("{}: {} given twice".format(where, key))
        current[key] = _scalar(value, where)
    if not seen_header:
        raise Unexpected("jobs.yaml is empty")
    return jobs


def validate_jobs(jobs: List[Dict[str, str]], repo: Path) -> List[Dict[str, object]]:
    out: List[Dict[str, object]] = []
    ids = set()
    for i, job in enumerate(jobs, 1):
        missing = REQUIRED_KEYS - set(job)
        if missing:
            raise Unexpected("job {}: missing {}".format(i, ", ".join(sorted(missing))))
        if not ID_RE.match(job["id"]) or job["id"] in ids:
            raise Unexpected("job {}: id {!r} must be a unique lower-case name".format(i, job["id"]))
        ids.add(job["id"])
        run = job["run"]
        target = (repo / run).resolve()
        if run.startswith("/") or ".." in Path(run).parts or not run.endswith(".py"):
            raise Unexpected("job {}: run must be a .py file inside the repo".format(job["id"]))
        if not target.is_file():
            raise Unexpected("job {}: {} does not exist".format(job["id"], run))
        timeout = job.get("timeout", str(DEFAULT_TIMEOUT // 60) + "m")
        timeout_s = parse_every(timeout)
        if timeout_s is None:
            raise Unexpected("job {}: timeout cannot be once".format(job["id"]))
        report = job.get("report", "false")
        if report not in ("true", "false"):
            raise Unexpected("job {}: report must be true or false".format(job["id"]))
        out.append({
            "id": job["id"], "run": run, "every": parse_every(job["every"]),
            "timeout": timeout_s, "report": report == "true",
        })
    if not out or out[0]["id"] != "follow":
        raise Unexpected("the first job must be 'follow'")
    return out


def load_jobs(repo: Path = REPO_ROOT) -> List[Dict[str, object]]:
    path = repo / "jobs.yaml"
    if not path.is_file():
        raise Unexpected("jobs.yaml is missing")
    return validate_jobs(parse_jobs_text(path.read_text(encoding="utf-8")), repo)
