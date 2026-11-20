#!/usr/bin/env python3
"""Prove a ticket's whole graph run in the cloud (JP-188). Python 3.9 or newer, standard library only.

One command carries the made-up fixture ticket (JP-9116) from Jira to an ended run on a sandbox laptop, with the real
Agent Manager (JP-186), the stand-in Claude Code and the strict fake Jira (JP-187):

    python3 scripts/e2e.py --scenario triage-happy --evidence <folder>
    python3 scripts/e2e.py --list

It launches a verify-josh-360 sandbox laptop (its own HOME and a bare `origin.git` for GitHub), starts a pinned Agent
Manager whose home is that HOME, makes a strict fake Jira holding the fixture, then runs the laptop's job runner
(`laptop/run_jobs.py`, which runs `graphs/runner/tick_job.py` as the `graph-runner` job) pass after pass until the run
ends or a limit passes. Every pass runs the way launchd runs it on the laptop: Python 3.9, a PATH with no
`~/.local/bin`, no credentials. Between passes the driver moves the sandbox's clock five minutes on (the laptop's
pace), so a run that takes an hour of laptop time takes a few minutes. The scenario files are `tests/e2e/runs/*.json`;
`tests/e2e/README.md` describes them.

Everything it saw goes in the evidence folder (runner.log, the run folder, the run report, the fake Jira's calls,
Agent Manager's sessions and calls, the stand-in's log, each pass) with `verdict.json` on top. Exit 0 when every check
of the scenario passed, 1 when one failed, 2 when the harness could not run (a missing tool or bad input).
"""
from __future__ import annotations

import argparse
import datetime
import importlib.util
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
from pathlib import Path
from typing import Dict, List, Optional

ROOT = Path(__file__).resolve().parent.parent
E2E = ROOT / "tests" / "e2e"
RUNS = E2E / "runs"
CLOCK_DIR = E2E / "clock"
SANDBOX = ROOT / ".claude" / "skills" / "verify-josh-360" / "scripts" / "sandbox.py"
PASS_SECONDS = 300                          # the laptop's job runner runs every five minutes
JOB_PATH = "/usr/bin:/bin:/usr/sbin:/sbin"   # launchd's PATH: no ~/.local/bin, no Homebrew, no stand-in
QUIET_SECONDS = 120                          # real seconds a pass may wait for the sessions it started to rest
sys.path.insert(0, str(E2E))
sys.path.insert(0, str(ROOT / "graphs" / "gates"))
import agent_manager  # noqa: E402
from lib import jira_strict  # noqa: E402


class Problem(Exception):
    """The harness cannot run (exit 2). The message says what is missing."""


def stamp() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def write_json(path: Path, doc: object) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    return path


def read_json(path: Path) -> Optional[dict]:
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
        return doc if isinstance(doc, dict) else None
    except (OSError, ValueError):
        return None


def load_sandbox():
    spec = importlib.util.spec_from_file_location("verify_josh360_sandbox", str(SANDBOX))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)                                      # type: ignore[union-attr]
    return module


# -- what a scenario says --------------------------------------------------------------------------------------------

def scenarios() -> Dict[str, dict]:
    return {p.stem: json.loads(p.read_text(encoding="utf-8")) for p in sorted(RUNS.glob("*.json"))}


def scenario(name: str) -> dict:
    found = scenarios().get(name)
    if found is None:
        raise Problem("no scenario '{}'; there are: {}".format(name, ", ".join(scenarios()) or "none"))
    return found


def standin_plan(doc: dict) -> dict:
    """The stand-in's plan with each scenario that names a file in tests/e2e/scenarios/ made absolute."""
    plan = json.loads(json.dumps(doc.get("plan") or {"default": "example"}))
    for step, name in list((plan.get("steps") or {}).items()):
        if isinstance(name, str) and name.endswith(".json"):
            plan["steps"][step] = str(E2E / "scenarios" / name)
    return plan


# -- tools -----------------------------------------------------------------------------------------------------------

def find_python(given: Optional[str]) -> str:
    """The laptop's Python is 3.9: --python, $JOSH360_E2E_PYTHON, python3.9 on PATH, or uv's 3.9."""
    candidates = [given, os.environ.get("JOSH360_E2E_PYTHON"), shutil.which("python3.9")]
    if not any(candidates) and shutil.which("uv"):
        found = subprocess.run(["uv", "python", "find", "3.9"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                               universal_newlines=True)
        candidates.append(found.stdout.strip() if found.returncode == 0 else None)
    for path in candidates:
        if not path:
            continue
        done = subprocess.run([path, "-c", "import sys; print('%d.%d' % sys.version_info[:2])"],
                              stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, universal_newlines=True)
        if done.returncode == 0 and done.stdout.strip() == "3.9":
            return str(Path(path).absolute())
    raise Problem("no Python 3.9 (the laptop's): install one (uv python install 3.9) or pass --python")


def check_tools() -> Path:
    problems = agent_manager.missing_tools()
    am = agent_manager.installed()
    if not am:
        problems.append("Agent Manager {} is not installed: python3 tests/e2e/agent_manager.py install".format(
            agent_manager.PINNED))
    if problems:
        raise Problem("; ".join(problems))
    return am


# -- the sandbox laptop ----------------------------------------------------------------------------------------------

class Laptop:
    """A sandbox laptop with Agent Manager, the fake Jira and the clock wired in."""

    def __init__(self, meta: dict, am_bin: Path, python: str, doc: dict, evidence: Path):
        self.meta, self.python, self.doc, self.evidence = meta, python, doc, evidence
        self.root = Path(meta["root"])
        self.home = Path(meta["home"])
        self.josh = self.home / ".josh-360"
        self.copy = self.josh / "repo"
        self.jira = self.root / "jira"
        self.clock = self.root / "clock"
        self.starts = self.root / "starts.json"
        self.am = agent_manager.Instance(self.root, am_bin)      # its home is the sandbox's HOME
        self.ticket = doc.get("ticket", "JP-9116")

    # -- setting up ---------------------------------------------------------------------------------------------
    def setup(self) -> None:
        self.clock.write_text("0\n", encoding="utf-8")
        self.am.setup()
        self.am.rails(self.copy)                     # ~/.claude/settings.json names the copy's hooks/dispatch
        self.am.plan(**standin_plan(self.doc))
        jira_strict.install(self.jira, fixtures=(self.ticket,))
        state = json.loads((self.jira / "fake-jira.json").read_text(encoding="utf-8"))
        state["apply_jql"] = True
        for key, extra in (self.doc.get("issues") or {}).items():         # made-up neighbours, such as the epic
            state["issues"][key] = {"key": key, "fields": {}}
            _fill(state["issues"][key]["fields"], extra)
        _fill(state["issues"][self.ticket]["fields"], self.doc.get("fixture") or {})
        (self.jira / "fake-jira.json").write_text(json.dumps(state), encoding="utf-8")
        write_json(self.starts, self.doc["starts"])
        self.am.start_manager()

    def env(self) -> Dict[str, str]:
        """A launchd job's environment on the laptop, pointed at this sandbox's Agent Manager, Jira and clock."""
        sandbox = load_sandbox()
        env = sandbox.sandbox_env(self.meta)
        am = self.am.env(env)
        for key in ("XDG_CONFIG_HOME", "TMUX_TMPDIR", "JOSH360_AM_BIN", "JOSH360_E2E_REAL_AM", "JOSH360_E2E_AM_LOG",
                    "JOSH360_AM_DB", "JOSH360_CLAUDE_BIN", "JOSH360_STANDIN_LOG", "JOSH360_STANDIN_PLAN"):
            env[key] = am[key]
        env.update({"PATH": JOB_PATH, "JOSH360_JIRA_FAKE": str(self.jira), "JOSH360_RUNNER_STARTS": str(self.starts),
                    "JOSH360_NO_NOTIFY": "1", "JOSH360_E2E_CLOCK": str(self.clock), "PYTHONPATH": str(CLOCK_DIR),
                    "LANG": "C.UTF-8"})
        for key in ("PYTHONHOME", "VIRTUAL_ENV", "TMUX", "TMUX_PANE"):
            env.pop(key, None)
        return env

    # -- the clock ------------------------------------------------------------------------------------------------
    def offset(self) -> float:
        try:
            return float(self.clock.read_text(encoding="utf-8").strip() or 0)
        except (OSError, ValueError):
            return 0.0

    def jump(self, seconds: float) -> None:
        self.clock.write_text("{}\n".format(self.offset() + seconds), encoding="utf-8")

    # -- running things on it --------------------------------------------------------------------------------------
    def run(self, argv: List[str], timeout: float = 900) -> subprocess.CompletedProcess:
        return subprocess.run(argv, cwd=str(self.copy), env=self.env(), stdin=subprocess.DEVNULL,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=timeout)

    def ledger(self, sql: str, args: tuple = ()) -> List[dict]:
        db = self.josh / "state" / "ledger.db"
        if not db.is_file():
            return []
        conn = sqlite3.connect("file:{}?mode=ro".format(db), uri=True, timeout=30)
        conn.row_factory = sqlite3.Row
        try:
            return [dict(r) for r in conn.execute(sql, args).fetchall()]
        finally:
            conn.close()

    def run_id(self) -> Optional[str]:
        rows = self.ledger("SELECT run_id FROM graph_runs WHERE ticket_key = ? AND graph_id = ? ORDER BY id DESC LIMIT 1",
                           (self.ticket, self.doc["graph"]))
        return rows[0]["run_id"] if rows else None

    def run_folder(self, run_id: str) -> Path:
        return self.josh / "runs" / run_id

    def run_doc(self, run_id: Optional[str]) -> Optional[dict]:
        return read_json(self.run_folder(run_id) / "run.json") if run_id else None

    def ended(self, run_id: Optional[str]) -> Optional[str]:
        if not run_id:
            return None
        rows = self.ledger("SELECT end_name FROM run_ends WHERE run_id = ? ORDER BY version DESC LIMIT 1", (run_id,))
        return rows[0]["end_name"] if rows else None

    def busy(self) -> List[str]:
        """What still moves on its own: an `advance` holding its lock, or a session Agent Manager says is not at rest."""
        found = []
        runs = self.josh / "runs"
        for lock in runs.glob("*/advance.lock") if runs.is_dir() else []:
            if _held(lock):
                found.append("advance {}".format(lock.parent.name))
        for row in self.am_sessions():
            if not row.get("archived") and row.get("status") in ("starting", "working"):
                found.append("session {} {}".format(row.get("name"), row.get("status")))
        return found

    def quiet(self, limit: float = QUIET_SECONDS) -> List[str]:
        deadline = time.monotonic() + limit
        time.sleep(1.0)
        while True:
            left = self.busy()
            if not left or time.monotonic() >= deadline:
                return left
            time.sleep(1.0)

    def am_sessions(self) -> List[dict]:
        if not self.am.db.is_file():
            return []
        conn = sqlite3.connect("file:{}?mode=ro".format(self.am.db), uri=True, timeout=30)
        conn.row_factory = sqlite3.Row
        try:
            return [dict(r) for r in conn.execute("SELECT * FROM sessions ORDER BY rowid").fetchall()]
        except sqlite3.Error:
            return []
        finally:
            conn.close()

    def jira_issue(self) -> dict:
        state = read_json(self.jira / "fake-jira.json") or {}
        return (state.get("issues") or {}).get(self.ticket) or {}


def _fill(fields: dict, values: dict) -> None:
    for name, value in values.items():
        fields[name] = {"name": value} if name in ("status", "issuetype") else value


def _held(lock: Path) -> bool:
    import fcntl
    try:
        fd = os.open(str(lock), os.O_RDWR)
    except OSError:
        return False
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.flock(fd, fcntl.LOCK_UN)
        return False
    except OSError:
        return True
    finally:
        os.close(fd)


# -- driving ---------------------------------------------------------------------------------------------------------

def launch(run: str, evidence: Path, allow_dirty: bool) -> dict:
    argv = [sys.executable, str(SANDBOX), "launch", "--run", run, "--evidence", str(evidence / "sandbox")]
    if allow_dirty:
        argv.append("--allow-dirty")
    done = subprocess.run(argv, cwd=str(ROOT), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          universal_newlines=True, timeout=900)
    try:
        said = json.loads(done.stdout)
    except ValueError:
        said = {"ok": False, "error": (done.stdout + done.stderr).strip()[-1000:]}
    if not said.get("ok"):
        raise Problem("the sandbox laptop did not launch: {}".format(said.get("error") or said.get("install_tail")))
    return json.loads((Path(said["root"]) / ".verify-josh-360").read_text(encoding="utf-8"))


def drive(laptop: Laptop, doc: dict, passes_log: Path, limit_minutes: float, wall_limit: float) -> dict:
    """Pass after pass of the job runner until the run ends, stops where the scenario says it stops, or a limit."""
    began = time.monotonic()
    outcome = {"why": "limit", "passes": 0}
    want_stop = (doc.get("expect") or {}).get("stopped_at")
    while True:
        e2e_minutes = laptop.offset() / 60.0
        if e2e_minutes >= limit_minutes:
            outcome["why"] = "e2e time limit ({} minutes)".format(limit_minutes)
            break
        if time.monotonic() - began >= wall_limit:
            outcome["why"] = "real time limit ({} seconds)".format(wall_limit)
            break
        laptop.jump(PASS_SECONDS)
        outcome["passes"] += 1
        done = laptop.run([laptop.python, "laptop/run_jobs.py"], timeout=900)
        left = laptop.quiet()
        run_id = laptop.run_id()
        run = laptop.run_doc(run_id) or {}
        ended = laptop.ended(run_id)
        line = {"pass": outcome["passes"], "e2e_minutes": round(laptop.offset() / 60.0, 1),
                "real_seconds": round(time.monotonic() - began, 1), "run_jobs_exit": done.returncode,
                "run_jobs": done.stdout.strip().splitlines(), "run_jobs_stderr": done.stderr.strip()[-2000:],
                "run": run_id, "ended": ended, "stopped": run.get("stopped"), "still_busy": left}
        with open(str(passes_log), "a", encoding="utf-8") as handle:
            handle.write(json.dumps(line, sort_keys=True) + "\n")
        if ended:
            outcome["why"] = "ended"
            break
        if want_stop and (run.get("stopped") or {}).get("step") == want_stop:
            outcome["why"] = "stopped"
            break
    outcome.update(e2e_minutes=round(laptop.offset() / 60.0, 1), real_seconds=round(time.monotonic() - began, 1))
    return outcome


# -- evidence --------------------------------------------------------------------------------------------------------

def collect(laptop: Laptop, evidence: Path, run_id: Optional[str]) -> dict:
    """Copy what the run left into the evidence folder and return what the checks read."""
    logs = laptop.josh / "logs"
    if logs.is_dir():
        shutil.copytree(str(logs), str(evidence / "logs"), dirs_exist_ok=True)
    state = laptop.josh / "state"
    for name in ("jobs-state.json", "runner/report.json", "runner/am-tickets.json"):
        if (state / name).is_file():
            target = evidence / "state" / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(str(state / name), str(target))
    if run_id and laptop.run_folder(run_id).is_dir():
        shutil.copytree(str(laptop.run_folder(run_id)), str(evidence / "run"), dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns("*.lock"))
    report = {}
    if run_id:
        done = laptop.run([laptop.python, "graphs/runner/runner.py", "report", "--run", run_id, "--json"], timeout=120)
        (evidence / "report.txt").write_text(done.stdout + done.stderr, encoding="utf-8")
        try:
            report = json.loads(done.stdout)
        except ValueError:
            report = {}
        write_json(evidence / "report.json", report)
    for name in ("fake-jira.json", "calls.jsonl"):
        if (laptop.jira / name).is_file():
            target = evidence / "jira" / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(str(laptop.jira / name), str(target))
    sessions = laptop.am_sessions()
    write_json(evidence / "agent-manager" / "sessions.json", {"sessions": sessions})
    for src, name in ((laptop.am.calls_log, "am-calls.jsonl"), (laptop.am.standin_log, "standin.jsonl"),
                      (laptop.am.standin_plan, "standin-plan.json")):
        if src.is_file():
            shutil.copyfile(str(src), str(evidence / "agent-manager" / name))
    return {"report": report, "am_sessions": sessions}


# -- the checks ------------------------------------------------------------------------------------------------------

def session_files(laptop: Laptop, run_id: Optional[str]) -> List[dict]:
    folder = laptop.run_folder(run_id) / "sessions" if run_id else None
    out = []
    for path in sorted(folder.glob("*.json")) if folder and folder.is_dir() else []:
        doc = read_json(path)
        if doc and "step" in doc and "attempt" in doc:
            out.append(doc)
    return out


def judge(laptop: Laptop, doc: dict, run_id: Optional[str], outcome: dict, seen: dict) -> List[dict]:
    expect = doc.get("expect") or {}
    checks: List[dict] = []

    def check(name: str, ok: bool, detail: object) -> None:
        checks.append({"check": name, "ok": bool(ok), "detail": detail})

    check("a run started for the ticket", bool(run_id), run_id)
    ended = laptop.ended(run_id)
    run = laptop.run_doc(run_id) or {}
    if "end" in expect:
        check("the run ended at its end state", ended == expect["end"], {"ended": ended, "want": expect["end"],
                                                                         "why_the_drive_stopped": outcome["why"]})
    if "jira_status" in expect:
        status = ((laptop.jira_issue().get("fields") or {}).get("status") or {}).get("name")
        check("the fake Jira shows the ticket in the status the graph sets", status == expect["jira_status"],
              {"status": status, "want": expect["jira_status"]})
    files = session_files(laptop, run_id)
    am_rows = {r["id"]: r for r in seen["am_sessions"]}
    if expect.get("one_session_per_role_step"):
        per_attempt = {}
        for f in files:
            handle = f.get("handle") or {}
            per_attempt["{}-{}".format(f["step"], f["attempt"])] = {
                "am_session": handle.get("am_session"), "in_agent_manager": handle.get("am_session") in am_rows,
                "earlier": len(f.get("earlier") or []), "state": f.get("state")}
        spawned = [c for c in laptop.am.calls("spawn") if c.get("code") == 0]
        ok = bool(files) and all(v["in_agent_manager"] and not v["earlier"] for v in per_attempt.values()) \
            and len(spawned) == len(files) == len(am_rows)
        check("every role step has one Agent Manager session", ok,
              {"steps": per_attempt, "spawns": len(spawned), "agent_manager_sessions": len(am_rows)})
    if expect.get("sessions_follow_status"):
        status = ((laptop.jira_issue().get("fields") or {}).get("status") or {}).get("name")
        binding = _binding(laptop)
        group = binding.ticket_group(status)
        completed = binding.completed_group()
        mine = sorted((f for f in files if f.get("n")), key=lambda f: f["n"])
        rows = [am_rows.get((f.get("handle") or {}).get("am_session")) or {} for f in mine]
        newest = rows[-1] if rows else {}
        earlier = rows[:-1]
        ok = bool(rows) and newest.get("group_name") == group and not newest.get("archived") and all(
            r.get("archived") or r.get("group_name") == completed for r in earlier)
        check("the newest session sits in the group for the ticket's status and the earlier ones are put away", ok,
              {"status": status, "want_group": group, "newest": _brief(newest),
               "earlier": [_brief(r) for r in earlier], "completed_group": completed})
    if "stopped_at" in expect:
        stopped = run.get("stopped") or {}
        check("the run stopped at the step", stopped.get("step") == expect["stopped_at"] and not ended,
              {"stopped": stopped, "ended": ended})
        limit = float(expect.get("within_minutes", 10))
        check("it stopped within {:g} minutes of e2e time".format(limit),
              outcome["why"] == "stopped" and outcome["e2e_minutes"] <= limit,
              {"e2e_minutes": outcome["e2e_minutes"], "why_the_drive_stopped": outcome["why"]})
    if expect.get("runner_log_names"):
        log = laptop.josh / "logs" / "runner" / "runner.log"
        text = log.read_text(encoding="utf-8") if log.is_file() else ""
        missing = [w for w in expect["runner_log_names"] if w not in text]
        check("runner.log names the refused output", not missing, {"missing": missing, "log": str(log)})
    return checks


def _binding(laptop: Laptop):
    spec = importlib.util.spec_from_file_location("e2e_binding", str(ROOT / "graphs" / "bindings" / "agent-manager" /
                                                                    "binding.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)                                      # type: ignore[union-attr]
    return module


def _brief(row: dict) -> dict:
    return {k: row.get(k) for k in ("id", "name", "group_name", "archived", "status")}


# -- the command line ------------------------------------------------------------------------------------------------

def main(argv: List[str]) -> int:
    parser = argparse.ArgumentParser(prog="e2e.py", description=__doc__.split("\n\n")[0])
    parser.add_argument("--scenario", help="a file in tests/e2e/runs/, without .json")
    parser.add_argument("--evidence", help="where the evidence goes (default docs/proof/<date>/e2e/<run>)")
    parser.add_argument("--run", help="the sandbox's run id (default e2e-<scenario>-<time>)")
    parser.add_argument("--python", help="the laptop's Python 3.9 (default: found)")
    parser.add_argument("--limit-minutes", type=float, help="e2e minutes before giving up (default: the scenario's)")
    parser.add_argument("--wall-limit", type=float, default=1200.0, help="real seconds before giving up")
    parser.add_argument("--allow-dirty", action="store_true", help="drive committed HEAD of a dirty checkout")
    parser.add_argument("--keep", action="store_true", help="leave the sandbox and Agent Manager running after")
    parser.add_argument("--list", action="store_true", help="list the scenarios and exit")
    a = parser.parse_args(argv)
    if a.list:
        print(json.dumps({n: d.get("about", "") for n, d in scenarios().items()}, indent=1, sort_keys=True))
        return 0
    if not a.scenario:
        parser.error("--scenario is required (or --list)")
    laptop = None
    try:
        doc = scenario(a.scenario)
        am_bin = check_tools()
        python = find_python(a.python)
        run = a.run or "e2e-{}-{}".format(a.scenario, stamp())
        evidence = Path(a.evidence).absolute() if a.evidence else (
            ROOT / "docs" / "proof" / datetime.date.today().isoformat() / "e2e" / run)
        evidence.mkdir(parents=True, exist_ok=True)
        meta = launch(run, evidence, a.allow_dirty)
        laptop = Laptop(meta, am_bin, python, doc, evidence)
        laptop.setup()
    except (Problem, agent_manager.Problem, OSError, subprocess.SubprocessError) as err:
        if laptop is not None and not a.keep:
            laptop.am.stop()
        print(json.dumps({"ok": False, "error": str(err)}, indent=1))
        return 2
    try:
        outcome = drive(laptop, doc, evidence / "passes.jsonl", a.limit_minutes or float(doc.get("limit_minutes", 120)),
                        a.wall_limit)
        run_id = laptop.run_id()
        seen = collect(laptop, evidence, run_id)
        checks = judge(laptop, doc, run_id, outcome, seen)
    finally:
        if not a.keep:
            laptop.am.stop()
    ok = bool(checks) and all(c["ok"] for c in checks)
    verdict = {"ok": ok, "scenario": a.scenario, "about": doc.get("about"), "run": run_id, "sandbox": meta["root"],
               "commit": meta["commit"], "python": python, "agent_manager": agent_manager.PINNED, "drive": outcome,
               "checks": checks, "evidence": str(evidence)}
    write_json(evidence / "verdict.json", verdict)
    if not a.keep:
        shutil.rmtree(str(laptop.root), ignore_errors=True)
    print(json.dumps(verdict, indent=1, sort_keys=True))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
