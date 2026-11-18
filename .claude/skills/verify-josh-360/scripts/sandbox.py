#!/usr/bin/env python3
"""A throwaway "laptop" for verifying josh-360 (JP-158). Python 3.9+, standard library only.

Every Josh 360 part that runs on the laptop reads ~/.josh-360 and ~/.claude, and the job runner pushes reports to
the copy's `origin`. This helper builds a fake laptop in one run folder so none of that reaches the real home folder
or GitHub:

    <run>/origin.git        a bare repo standing in for GitHub; its `main` is the checkout's HEAD
    <run>/home              HOME for every command; ~/.josh-360/repo is a clone of origin.git at main
    <run>/work/<name>       made-up working folders that seeded sessions "ran" in
    <run>/payloads          hook inputs written by `seed-session`
    <run>/.verify-josh-360  the marker that says this helper made the folder (cleanup refuses without it)

Evidence goes OUTSIDE the run folder, by default <checkout>/docs/proof/<date>/verify-josh-360/<run-id>/, so cleanup
never removes it.

    sandbox.py launch  [--run ID] [--evidence DIR] [--allow-dirty] [--harness DIR]
    sandbox.py doctor  --run ID
    sandbox.py run     --run ID [--name NAME] [--stdin FILE] [--cwd DIR] -- COMMAND...
    sandbox.py hook    --run ID --event EVENT --payload FILE [--name NAME]
    sandbox.py seed-session --run ID [--session ID] [--branch NAME] [--folder NAME]
    sandbox.py advance-main --run ID [--message TEXT]
    sandbox.py ledger  --run ID [--name NAME] SQL
    sandbox.py env     --run ID
    sandbox.py cleanup --run ID

Every subcommand prints JSON on stdout. Exit 0 on success, 1 when a check fails, 2 for bad input.
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import shutil
import sqlite3
import subprocess
import sys
from pathlib import Path
from typing import Dict, List, Optional

CHECKOUT = Path(__file__).resolve().parents[4]
RUN_ROOT = Path(os.environ.get("VERIFY_JOSH360_ROOT") or os.path.join(os.environ.get("TMPDIR", "/tmp"),
                                                                      "verify-josh-360"))
MARKER = ".verify-josh-360"
HOOKS_SCRIPT = Path("scripts") / "add-josh-360-hooks.py"   # claude-harness's hook installer, which doctor --fix runs
# Credentials are never passed into the sandbox, so nothing a feature does there can write to Jira, GitHub or Azure.
SECRET_PREFIXES = ("JOSH360_JIRA_", "ACTION_AGENT_JIRA_", "ACTION_TRIAGE_JIRA", "ATLASSIAN", "GH_", "GITHUB_",
                   "AZURE_", "ANTHROPIC_", "JOSH360_AZ")
# The doctor checks that must pass before an instance is worth driving.
REQUIRED_PASS = ("install.home", "install.copy", "install.runs-from-copy", "install.installed-commit",
                 "install.jobs-file", "install.not-paused", "hooks.files", "data.ledger", "data.ledger-shape",
                 "graphs.compiled", "graphs.walker")


def now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def out(obj: object, code: int = 0) -> int:
    print(json.dumps(obj, indent=2, sort_keys=True))
    return code


def fail(message: str, code: int = 2) -> int:
    return out({"ok": False, "error": message}, code)


def git(args: List[str], cwd: Path, env: Optional[Dict[str, str]] = None) -> str:
    return subprocess.run(["git", *args], cwd=str(cwd), env=env, check=True, capture_output=True,
                          text=True).stdout.strip()


def find_harness(given: Optional[str]) -> Optional[Path]:
    """claude-harness (Josh's ~/.claude): --harness, else the real ~/.claude, else a clone beside this checkout."""
    for candidate in ([Path(given)] if given else []) + [Path.home() / ".claude", CHECKOUT.parent / "claude-harness"]:
        if (candidate / HOOKS_SCRIPT).is_file():
            return candidate
    return None


def run_dir(run_id: str) -> Path:
    if not run_id or "/" in run_id or run_id.startswith("."):
        raise SystemExit(fail("bad run id: {!r}".format(run_id)))
    return RUN_ROOT / run_id


def load_marker(run_id: str) -> dict:
    marker = run_dir(run_id) / MARKER
    if not marker.is_file():
        raise SystemExit(fail("no sandbox {} (no {} marker); run `launch` first".format(run_dir(run_id), MARKER)))
    return json.loads(marker.read_text())


def sandbox_env(meta: dict) -> Dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not k.startswith(SECRET_PREFIXES)}
    home = meta["home"]
    env.update({"HOME": home, "JOSH360_HOME": os.path.join(home, ".josh-360"), "GIT_TERMINAL_PROMPT": "0",
                "GIT_CONFIG_NOSYSTEM": "1", "NO_COLOR": "1"})
    for key in ("JOSH360_RUNS", "JOSH360_QUESTIONS_DIR", "ACTION_AGENT_STATE_PATH", "JOSH360_STARTUP_REPO",
                "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME"):
        env.pop(key, None)
    return env


def copy_path(meta: dict) -> Path:
    return Path(meta["home"]) / ".josh-360" / "repo"


def save(meta: dict, name: str, record: dict) -> str:
    folder = Path(meta["evidence"])
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / "{}.json".format(name)
    path.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n")
    return str(path)


def execute(meta: dict, argv: List[str], name: Optional[str], stdin: Optional[str] = None,
            cwd: Optional[Path] = None) -> dict:
    cwd = cwd or copy_path(meta)
    started = now()
    proc = subprocess.run(argv, cwd=str(cwd), env=sandbox_env(meta), input=stdin, capture_output=True, text=True,
                          timeout=900)
    record = {"run": meta["run"], "command": argv, "cwd": str(cwd), "started_at": started, "exit_code": proc.returncode,
              "stdout": proc.stdout, "stderr": proc.stderr}
    if stdin is not None:
        record["stdin"] = stdin
    if name:
        record["evidence"] = save(meta, name, record)
    return record


# --- subcommands ---------------------------------------------------------------------------------------------------
def cmd_launch(a: argparse.Namespace) -> int:
    run_id = a.run or datetime.datetime.now(datetime.timezone.utc).strftime("run-%Y%m%dT%H%M%SZ")
    root = run_dir(run_id)
    if root.exists():
        return fail("{} already exists; pick another --run or clean it up".format(root))
    dirty = git(["status", "--porcelain", "--untracked-files=no"], CHECKOUT)
    if dirty and not a.allow_dirty:
        return fail("the checkout has uncommitted changes; the sandbox drives committed HEAD only. Commit first, or "
                    "pass --allow-dirty to drive HEAD anyway")
    commit = git(["rev-parse", "HEAD"], CHECKOUT)
    evidence = Path(a.evidence).absolute() if a.evidence else (
        CHECKOUT / "docs" / "proof" / datetime.date.today().isoformat() / "verify-josh-360" / run_id)
    home = root / "home"
    home.mkdir(parents=True)
    meta = {"run": run_id, "root": str(root), "home": str(home), "origin": str(root / "origin.git"),
            "checkout": str(CHECKOUT), "commit": commit, "evidence": str(evidence), "created_at": now(),
            "created_by_pid": os.getpid(), "dirty_at_launch": bool(dirty)}
    (root / MARKER).write_text(json.dumps(meta, indent=2, sort_keys=True) + "\n")
    (home / ".claude").mkdir()
    (home / ".claude" / "settings.json").write_text("{}\n")   # a fresh Claude Code home has one; the hook installer needs it
    harness = find_harness(a.harness)
    if harness:
        target = home / ".claude" / HOOKS_SCRIPT
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(str(harness / HOOKS_SCRIPT), str(target))
    meta["harness_hooks_script"] = str(harness / HOOKS_SCRIPT) if harness else None
    (root / MARKER).write_text(json.dumps(meta, indent=2, sort_keys=True) + "\n")
    (home / ".gitconfig").write_text("[user]\n\tname = verify-josh-360\n\temail = verify@example.invalid\n"
                                     "[init]\n\tdefaultBranch = main\n")
    env = sandbox_env(meta)
    git(["clone", "--quiet", "--bare", "--no-hardlinks", str(CHECKOUT), meta["origin"]], root, env)
    git(["update-ref", "refs/heads/main", commit], Path(meta["origin"]), env)
    git(["symbolic-ref", "HEAD", "refs/heads/main"], Path(meta["origin"]), env)
    git(["clone", "--quiet", "--branch", "main", meta["origin"], str(copy_path(meta))], root, env)
    install = execute(meta, [sys.executable, "laptop/install.py", "--json"], "launch-install")
    ready = install["exit_code"] == 0 and '"result": "passed"' in install["stdout"]
    return out({"ok": ready, "run": run_id, "root": str(root), "home": str(home), "commit": commit,
                "evidence": str(evidence), "install_exit": install["exit_code"],
                "harness_hooks_script": meta["harness_hooks_script"],
                "install_tail": install["stdout"].strip().splitlines()[-3:],
                "next": "sandbox.py doctor --run {}".format(run_id)}, 0 if ready else 1)


def cmd_doctor(a: argparse.Namespace) -> int:
    meta = load_marker(a.run)
    copy = copy_path(meta)
    problems = []
    origin = git(["remote", "get-url", "origin"], copy)
    if os.path.abspath(origin) != meta["origin"]:
        problems.append("the copy's origin is {}, not the sandbox's bare repo".format(origin))
    head = git(["rev-parse", "HEAD"], copy)
    main = git(["rev-parse", "refs/heads/main"], Path(meta["origin"]))
    if head != main:
        problems.append("the copy is at {}, not the sandbox's main {}".format(head[:12], main[:12]))
    doc = execute(meta, [sys.executable, "scripts/doctor.py", "--json", "--no-manual"], None)
    try:
        report = json.loads(doc["stdout"])
    except ValueError:
        report = {"checks": []}
        problems.append("the platform doctor printed no JSON: {}".format(doc["stderr"].strip()[-300:]))
    status = {c["id"]: c["status"] for c in report.get("checks", [])}
    for cid in REQUIRED_PASS:
        if status.get(cid) != "pass":
            problems.append("doctor check {} is {}".format(cid, status.get(cid, "missing")))
    verdict = {"ok": not problems, "run": meta["run"], "commit": head, "main": main, "origin": origin, "problems": problems,
               "required_pass": list(REQUIRED_PASS), "doctor_summary": report.get("summary"),
               "checked_at": now()}
    verdict["evidence"] = save(meta, "doctor", dict(verdict, doctor_report=report))
    return out(verdict, 0 if not problems else 1)


def cmd_run(a: argparse.Namespace) -> int:
    meta = load_marker(a.run)
    argv = a.command[1:] if a.command[:1] == ["--"] else a.command
    if not argv:
        return fail("no command after --")
    stdin = Path(a.stdin).read_text() if a.stdin else None
    record = execute(meta, argv, a.name, stdin, Path(a.cwd) if a.cwd else None)
    return out(record, 0 if record["exit_code"] == 0 else 1)


def cmd_hook(a: argparse.Namespace) -> int:
    meta = load_marker(a.run)
    payload = Path(a.payload).read_text()
    record = execute(meta, ["hooks/dispatch", a.event], a.name or "hook-{}".format(a.event), payload)
    return out(record, 0 if record["exit_code"] in (0, 2) else 1)


def cmd_seed_session(a: argparse.Namespace) -> int:
    """A made-up session: a git working folder, a transcript with no real text, and its two hook inputs."""
    meta = load_marker(a.run)
    env = sandbox_env(meta)
    root = Path(meta["root"])
    work = root / "work" / a.folder
    work.mkdir(parents=True, exist_ok=True)
    git(["init", "--quiet", "-b", a.branch], work, env)
    (work / "notes.md").write_text("made-up sample work for verify-josh-360\n")
    git(["add", "notes.md"], work, env)
    git(["commit", "--quiet", "-m", "sample commit"], work, env)
    slug = str(work).replace("/", "-")
    transcript = Path(meta["home"]) / ".claude" / "projects" / slug / "{}.jsonl".format(a.session)
    transcript.parent.mkdir(parents=True, exist_ok=True)
    stamps = ["2026-11-18T09:00:00Z", "2026-11-18T09:01:00Z", "2026-11-18T09:05:00Z"]
    lines = []
    for i, (kind, at) in enumerate(zip(("user", "assistant", "assistant"), stamps)):
        line = {"type": kind, "timestamp": at, "sessionId": a.session, "uuid": "u-{}".format(i),
                "isSidechain": False, "cwd": str(work), "gitBranch": a.branch}
        line["message"] = ({"role": "user", "content": "made-up request for a sample check"} if kind == "user" else
                           {"role": "assistant", "content": [{"type": "text", "text": "made-up sample answer"}]})
        lines.append(json.dumps(line))
    transcript.write_text("\n".join(lines) + "\n")
    payloads = root / "payloads"
    payloads.mkdir(exist_ok=True)
    start = {"session_id": a.session, "transcript_path": str(transcript), "cwd": str(work),
             "hook_event_name": "SessionStart", "source": "startup"}
    end = dict(start, hook_event_name="SessionEnd", reason="other")
    end.pop("source")
    (payloads / "{}-start.json".format(a.session)).write_text(json.dumps(start))
    (payloads / "{}-end.json".format(a.session)).write_text(json.dumps(end))
    record = {"ok": True, "session": a.session, "folder": str(work), "branch": a.branch, "transcript": str(transcript),
              "start_payload": str(payloads / "{}-start.json".format(a.session)),
              "end_payload": str(payloads / "{}-end.json".format(a.session))}
    record["evidence"] = save(meta, "seed-{}".format(a.session), record)
    return out(record)


def cmd_advance_main(a: argparse.Namespace) -> int:
    """Put one made-up commit on the sandbox's main, as a merge to GitHub's main would."""
    meta = load_marker(a.run)
    env = sandbox_env(meta)
    root = Path(meta["root"])
    scratch = root / "advance-main"
    if scratch.exists():
        shutil.rmtree(str(scratch))
    git(["clone", "--quiet", "--branch", "main", meta["origin"], str(scratch)], root, env)
    note = scratch / "docs" / "proof" / "verify-josh-360-sample.txt"
    note.parent.mkdir(parents=True, exist_ok=True)
    with note.open("a") as f:
        f.write("made-up change {}\n".format(now()))
    git(["add", str(note.relative_to(scratch))], scratch, env)
    git(["commit", "--quiet", "-m", a.message], scratch, env)
    git(["push", "--quiet", "origin", "main"], scratch, env)
    commit = git(["rev-parse", "HEAD"], scratch)
    shutil.rmtree(str(scratch))
    record = {"ok": True, "run": meta["run"], "main": commit, "message": a.message}
    record["evidence"] = save(meta, "advance-main", record)
    return out(record)


def cmd_ledger(a: argparse.Namespace) -> int:
    """A read-only second view of what the ledger stored (SQLite opened with mode=ro)."""
    meta = load_marker(a.run)
    db = Path(meta["home"]) / ".josh-360" / "state" / "ledger.db"
    con = sqlite3.connect("file:{}?mode=ro".format(db), uri=True)
    con.row_factory = sqlite3.Row
    try:
        rows = [dict(r) for r in con.execute(a.sql).fetchall()]
    except sqlite3.Error as e:
        return fail("the query failed: {}".format(e))
    finally:
        con.close()
    record = {"run": meta["run"], "database": str(db), "sql": a.sql, "rows": rows, "read_at": now()}
    if a.name:
        record["evidence"] = save(meta, a.name, record)
    return out(record)


def cmd_env(a: argparse.Namespace) -> int:
    meta = load_marker(a.run)
    env = sandbox_env(meta)
    return out({"run": meta["run"], "copy": str(copy_path(meta)), "evidence": meta["evidence"],
                "export": {k: env[k] for k in ("HOME", "JOSH360_HOME", "GIT_TERMINAL_PROMPT")}})


def cmd_cleanup(a: argparse.Namespace) -> int:
    meta = load_marker(a.run)
    root = Path(meta["root"]).resolve()
    if root.parent != RUN_ROOT.resolve():
        return fail("{} is not inside {}; refusing to remove it".format(root, RUN_ROOT), 1)
    evidence = Path(meta["evidence"])
    if evidence.resolve() == root or root in evidence.resolve().parents:
        return fail("the evidence folder is inside the run folder; refusing to remove it", 1)
    shutil.rmtree(str(root))
    kept = sorted(p.name for p in evidence.iterdir()) if evidence.is_dir() else []
    return out({"ok": not root.exists() and bool(kept), "removed": str(root), "evidence": str(evidence),
                "evidence_files": kept}, 0 if kept else 1)


def main(argv: List[str]) -> int:
    p = argparse.ArgumentParser(prog="sandbox.py", description=__doc__.split("\n\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("launch")
    s.add_argument("--run")
    s.add_argument("--evidence")
    s.add_argument("--allow-dirty", action="store_true")
    s.add_argument("--harness")
    for name in ("doctor", "env", "cleanup"):
        sub.add_parser(name).add_argument("--run", required=True)
    s = sub.add_parser("run")
    s.add_argument("--run", required=True)
    s.add_argument("--name")
    s.add_argument("--stdin")
    s.add_argument("--cwd")
    s.add_argument("command", nargs=argparse.REMAINDER)
    s = sub.add_parser("hook")
    s.add_argument("--run", required=True)
    s.add_argument("--event", required=True)
    s.add_argument("--payload", required=True)
    s.add_argument("--name")
    s = sub.add_parser("seed-session")
    s.add_argument("--run", required=True)
    s.add_argument("--session", default="verify-sess-0001")
    s.add_argument("--branch", default="JP-9001-sample-work")
    s.add_argument("--folder", default="sample-repo")
    s = sub.add_parser("advance-main")
    s.add_argument("--run", required=True)
    s.add_argument("--message", default="made-up change on main (verify-josh-360)")
    s = sub.add_parser("ledger")
    s.add_argument("--run", required=True)
    s.add_argument("--name")
    s.add_argument("sql")
    a = p.parse_args(argv)
    return {"launch": cmd_launch, "doctor": cmd_doctor, "run": cmd_run, "hook": cmd_hook,
            "seed-session": cmd_seed_session, "advance-main": cmd_advance_main, "ledger": cmd_ledger, "env": cmd_env, "cleanup": cmd_cleanup}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
