"""The doctor's shared pieces (JP-152): a result, the context every check reads, and the runner.

A check is a function that takes the context and returns one Result (or a list of them). It reads the laptop and
changes nothing; a check that cannot decide says so (WARN or SKIP) instead of guessing. The only code that changes
anything is fixes.py, and only when the doctor is started with --fix.
"""
from __future__ import annotations

import datetime
import os
import sqlite3
import subprocess
import sys
import urllib.request
from pathlib import Path
from typing import Callable, Dict, List, Optional, Sequence, Tuple, Union

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))
from laptop import common  # noqa: E402

PASS, WARN, FAIL, SKIP = "pass", "warn", "fail", "skip"
STATUSES = (PASS, WARN, FAIL, SKIP)
JOBS_RUNNER_LABEL = "com.jgilpatrick.josh-360-jobs"
Runner = Callable[[Sequence[str], float], Tuple[int, str, str]]
HttpGet = Callable[[str, float], Tuple[int, str]]


class Result:
    """One line of the report. `fix` is the one step that puts it right; `fix_key` names the safe step --fix can take."""

    def __init__(self, check_id: str, status: str, detail: str, fix: str = "", fix_key: str = "") -> None:
        assert status in STATUSES, status
        self.id = check_id
        self.group = check_id.split(".", 1)[0]
        self.status = status
        self.detail = detail
        self.fix = fix
        self.fix_key = fix_key

    def as_dict(self) -> Dict[str, object]:
        return {"id": self.id, "group": self.group, "status": self.status, "detail": self.detail,
                "fix": self.fix, "auto_fix": self.fix_key or None}


def _default_runner(argv: Sequence[str], timeout: float) -> Tuple[int, str, str]:
    try:
        done = subprocess.run(list(argv), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              universal_newlines=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return 124, "", "timed out after {}s".format(int(timeout))
    except OSError as e:
        return 127, "", "{}: {}".format(e.__class__.__name__, e)
    return done.returncode, done.stdout, done.stderr


def _default_http_get(url: str, timeout: float) -> Tuple[int, str]:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:  # noqa: S310  (a fixed http://127.0.0.1 address)
            return response.status, response.read(4096).decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001  (any failure means "did not answer")
        return 0, e.__class__.__name__


class Ctx:
    """Everything a check may look at. Tests hand in a made-up home, runner and clock."""

    def __init__(self, home: Optional[Path] = None, user_home: Optional[Path] = None,
                 env: Optional[Dict[str, str]] = None, now: Optional[datetime.datetime] = None,
                 runner: Optional[Runner] = None, http_get: Optional[HttpGet] = None, online: bool = False,
                 code_root: Path = ROOT, jira_fetch: Optional[Callable] = None) -> None:
        self.env = dict(os.environ if env is None else env)
        self.home = (home or common.home()).absolute()
        self.user_home = (user_home or Path.home()).absolute()
        self.now = now or datetime.datetime.now(datetime.timezone.utc)
        self.run = runner or _default_runner
        self.http_get = http_get or _default_http_get
        self.online = online
        self.code_root = code_root  # the checkout this doctor runs from
        self.jira_fetch = jira_fetch  # a GET function for Jira, or None to build the real one (only used with --online)
        self.copy = self.home / "repo"  # the laptop's own copy: what the laptop really runs
        self.state = self.home / "state"
        self.logs = self.home / "logs"
        self.settings_path = self.user_home / ".claude" / "settings.json"
        self._jobs: Optional[Union[List[dict], str]] = None
        self._job_state: Optional[dict] = None

    # -- paths ------------------------------------------------------------------------------------------------
    def tilde(self, path: Union[str, Path]) -> str:
        text = str(path)
        home = str(self.user_home)
        return "~" + text[len(home):] if text == home or text.startswith(home + os.sep) else text

    def age_seconds(self, epoch: float) -> float:
        return self.now.timestamp() - epoch

    # -- the jobs file and the runner's record -------------------------------------------------------------------
    def jobs(self) -> Union[List[dict], str]:
        """The jobs in the laptop copy's jobs.yaml, or the reason it cannot be read (a string)."""
        if self._jobs is None:
            try:
                path = self.copy / "jobs.yaml"
                if not path.is_file():
                    raise common.Unexpected("jobs.yaml is missing from {}".format(self.tilde(self.copy)))
                self._jobs = common.validate_jobs(common.parse_jobs_text(path.read_text(encoding="utf-8")), self.copy)
            except (common.Unexpected, OSError, UnicodeDecodeError) as e:
                self._jobs = str(e)
        return self._jobs

    def job_state(self) -> Optional[dict]:
        """jobs-state.json as a dict ({} when the runner has never run), or None when the file cannot be read."""
        if self._job_state is None:
            path = self.state / "jobs-state.json"
            try:
                data = common.read_json(path, {})
                self._job_state = data if isinstance(data, dict) else None
            except (OSError, ValueError):
                self._job_state = None
        return self._job_state

    # -- reading -----------------------------------------------------------------------------------------------------
    def sqlite_ro(self, path: Path) -> sqlite3.Connection:
        """A read-only connection. It cannot write, so a check can never change a database.

        A database in WAL mode that nobody has open (no -wal file beside it) is read as `immutable`: SQLite then does
        not create a -shm file, so the doctor leaves the folder exactly as it found it. One that is in use (a -wal file
        exists) is read with mode=ro, which only reads the files the writer already keeps."""
        if not path.is_file():  # SQLite would create an empty file for an immutable open of a missing one
            raise FileNotFoundError(str(path))
        quoted = str(path).replace("%", "%25").replace("?", "%3f").replace("#", "%23")
        in_use = Path(str(path) + "-wal").exists()
        conn = sqlite3.connect("file:{}?{}".format(quoted, "mode=ro" if in_use else "immutable=1"), uri=True, timeout=5.0)
        conn.execute("PRAGMA query_only = ON")
        return conn

    def launchd_loaded(self, label: str) -> Optional[bool]:
        """True or False, or None when this is not a Mac (no launchctl) or launchctl would not answer."""
        program = self.env.get("JOSH360_LAUNCHCTL", "launchctl")
        code, _, _ = self.run([program, "print", "gui/{}/{}".format(os.getuid(), label)], 20)
        if code == 0:
            return True
        if code in (124, 127):
            return None
        return False


Check = Callable[[Ctx], Union[Result, List[Result]]]
REGISTRY: List[Tuple[str, str, Check]] = []  # (group, name, function), in the order they were defined


def check(group: str, name: str) -> Callable[[Check], Check]:
    def register(fn: Check) -> Check:
        REGISTRY.append((group, name, fn))
        return fn
    return register


def run_checks(ctx: Ctx, groups: Optional[Sequence[str]] = None) -> List[Result]:
    """Run every registered check. A check that crashes becomes a FAIL for that check only, never a crash."""
    results: List[Result] = []
    for group, name, fn in REGISTRY:
        if groups and group not in groups:
            continue
        try:
            out = fn(ctx)
        except Exception as e:  # noqa: BLE001  (the doctor reports a broken check, it does not die of one)
            results.append(Result("{}.{}".format(group, name), FAIL,
                                  "the check itself crashed ({}); report it as a doctor bug".format(e.__class__.__name__)))
            continue
        results.extend(out if isinstance(out, list) else [out])
    return results


def summarise(results: Sequence[Result]) -> Dict[str, int]:
    return {s: sum(1 for r in results if r.status == s) for s in STATUSES}
