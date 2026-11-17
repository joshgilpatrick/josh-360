"""Install, follow and job checks (JP-152): is the laptop's copy of josh-360 present, on main and installed, and are
the background jobs from jobs.yaml running. Reads only; the proofs these come from are JP-105, JP-107, JP-111 and
JP-112."""
from __future__ import annotations

import sys
from pathlib import Path
from typing import List

sys.dont_write_bytecode = True
from . import core  # noqa: E402
from .core import FAIL, PASS, SKIP, WARN, Ctx, Result, check  # noqa: E402

FOLLOW_FRESH_SECONDS = 30 * 60
OVERDUE_FACTOR = 3
OVERDUE_SLACK_SECONDS = 15 * 60
# A job that waits for another: while the other has not succeeded, "not yet" is expected, not a failure.
DEPENDS = {"retire-session-atlas": "ledger-backfill", "session-atlas-service": "retire-session-atlas"}
STARTUP_FIX = ("cd ~/Development/active/josh_projects/macbook_automations && git pull && scripts/startup.sh "
               "(JP-105 step 2)")


def ago(seconds: float) -> str:
    seconds = max(0, int(seconds))
    if seconds < 90:
        return "{}s ago".format(seconds)
    if seconds < 5400:
        return "{} min ago".format(round(seconds / 60))
    if seconds < 172800:
        return "{} h ago".format(round(seconds / 3600))
    return "{} days ago".format(round(seconds / 86400))


def git(ctx: Ctx, *args: str):
    return ctx.run(["git", "--no-optional-locks", "-c", "core.hooksPath=/dev/null", "-C", str(ctx.copy)] + list(args), 30)


@check("install", "python")
def python_version(ctx: Ctx) -> Result:
    v = sys.version_info
    text = "Python {}.{}.{} ({})".format(v[0], v[1], v[2], sys.executable)
    if v >= (3, 9):
        return Result("install.python", PASS, text)
    return Result("install.python", FAIL, text + " is older than 3.9, which the laptop code needs",
                  "run the doctor with /usr/bin/python3, which is 3.9")


@check("install", "home")
def home_folders(ctx: Ctx) -> Result:
    missing = [ctx.tilde(p) for p in (ctx.home, ctx.state, ctx.logs) if not p.is_dir()]
    if not missing:
        return Result("install.home", PASS, "{} has state/ and logs/".format(ctx.tilde(ctx.home)))
    return Result("install.home", FAIL, "missing: " + ", ".join(missing),
                  "python3 ~/.josh-360/repo/laptop/install.py (or: doctor --fix)", "install")


@check("install", "copy")
def laptop_copy(ctx: Ctx) -> Result:
    if not (ctx.copy / ".git").exists():
        return Result("install.copy", FAIL, "{} is not a git checkout; the laptop has not installed josh-360".format(
            ctx.tilde(ctx.copy)), STARTUP_FIX)
    return Result("install.copy", PASS, "{} is a git checkout".format(ctx.tilde(ctx.copy)))


@check("install", "runs-from-copy")
def runs_from_copy(ctx: Ctx) -> Result:
    if Path(ctx.code_root).resolve() == ctx.copy.resolve():
        return Result("install.runs-from-copy", PASS, "the doctor runs from the laptop's copy")
    return Result("install.runs-from-copy", WARN,
                  "the doctor runs from {}, not the laptop's copy; file checks read the copy".format(ctx.tilde(ctx.code_root)),
                  "python3 ~/.josh-360/repo/scripts/doctor.py")


@check("install", "follows-main")
def follows_main(ctx: Ctx) -> Result:
    cid = "install.follows-main"
    if not (ctx.copy / ".git").exists():
        return Result(cid, SKIP, "there is no copy to look at")
    code, head, _ = git(ctx, "rev-parse", "HEAD")
    code2, main, _ = git(ctx, "rev-parse", "--verify", "-q", "refs/remotes/origin/main")
    if code != 0 or code2 != 0:
        return Result(cid, FAIL, "the copy has no origin/main; follow has never fetched",
                      "python3 ~/.josh-360/repo/laptop/follow.py")
    head, main = head.strip(), main.strip()
    _, dirty, _ = git(ctx, "status", "--porcelain", "--untracked-files=no")
    if dirty.strip():
        return Result(cid, FAIL, "the copy has local changes, so follow refuses to install",
                      "git -C ~/.josh-360/repo status, then undo what you did not mean to keep")
    if head == main:
        return Result(cid, PASS, "on main at {}, no local changes".format(head[:7]))
    ahead, _, _ = git(ctx, "merge-base", "--is-ancestor", head, main)
    if ahead == 0:
        _, n, _ = git(ctx, "rev-list", "--count", "{}..{}".format(head, main))
        return Result(cid, FAIL, "installed {} is {} commit(s) behind main {}".format(head[:7], n.strip() or "?", main[:7]),
                      "wait for the next follow pass (every 10 minutes), or run python3 ~/.josh-360/repo/laptop/follow.py")
    return Result(cid, FAIL, "installed {} is not on main {}'s history".format(head[:7], main[:7]),
                  "read ~/.josh-360/logs/follow.log; follow only ever moves forward")


@check("install", "installed-commit")
def installed_commit(ctx: Ctx) -> Result:
    cid = "install.installed-commit"
    path = ctx.state / "installed.json"
    try:
        recorded = str(core.common.read_json(path, {}).get("commit", ""))
    except (OSError, ValueError, AttributeError):
        recorded = ""
    if not recorded:
        return Result(cid, FAIL, "{} is missing or unreadable: no install has been recorded".format(ctx.tilde(path)),
                      "python3 ~/.josh-360/repo/laptop/install.py (or: doctor --fix)", "install")
    code, head, _ = git(ctx, "rev-parse", "HEAD")
    if code == 0 and head.strip() == recorded:
        return Result(cid, PASS, "the install record matches the copy ({})".format(recorded[:7]))
    return Result(cid, FAIL, "the install record ({}) does not match the copy ({})".format(
        recorded[:7], head.strip()[:7] or "unknown"),
        "python3 ~/.josh-360/repo/laptop/install.py (or: doctor --fix)", "install")


@check("install", "follow-ran")
def follow_ran(ctx: Ctx) -> Result:
    cid = "install.follow-ran"
    state = ctx.job_state()
    if state is None:
        return Result(cid, FAIL, "{} cannot be read".format(ctx.tilde(ctx.state / "jobs-state.json")),
                      "read ~/.josh-360/logs/run_jobs.log, then python3 ~/.josh-360/repo/laptop/run_jobs.py")
    record = state.get("follow")
    if not record:
        return Result(cid, FAIL, "the follow job has never run", STARTUP_FIX)
    age = ctx.age_seconds(float(record.get("last_run", 0) or 0))
    if record.get("last_result") != 0:
        return Result(cid, FAIL, "the follow job's last run ({}) exited {}".format(ago(age), record.get("last_result")),
                      "read ~/.josh-360/logs/follow.log")
    if age > FOLLOW_FRESH_SECONDS:
        return Result(cid, WARN, "the follow job last ran {}; it runs every 10 minutes".format(ago(age)),
                      "check the runner is loaded (install.runner-launchd) and the laptop was awake")
    return Result(cid, PASS, "the follow job ran {} and exited 0".format(ago(age)))


@check("install", "not-paused")
def not_paused(ctx: Ctx) -> Result:
    if (ctx.home / "PAUSED").exists():
        return Result("install.not-paused", FAIL, "paused: the follow job installs nothing (PAUSED file)",
                      "python3 ~/.josh-360/repo/laptop/pause.py off, if you mean to resume")
    return Result("install.not-paused", PASS, "no PAUSED file")


@check("install", "runner-launchd")
def runner_loaded(ctx: Ctx) -> Result:
    cid = "install.runner-launchd"
    loaded = ctx.launchd_loaded(core.JOBS_RUNNER_LABEL)
    if loaded is None:
        return Result(cid, SKIP, "launchctl is not available here (not a Mac)")
    if loaded:
        return Result(cid, PASS, "{} is loaded in launchd".format(core.JOBS_RUNNER_LABEL))
    return Result(cid, FAIL, "{} is not loaded: nothing runs the jobs".format(core.JOBS_RUNNER_LABEL), STARTUP_FIX)


@check("install", "remote-main")
def remote_main(ctx: Ctx) -> List[Result]:
    """Only with --online: does GitHub hold a newer main than the laptop last fetched, and is a pause branch up?"""
    if not ctx.online:
        return []
    out: List[Result] = []
    code, listing, err = ctx.run(["git", "-c", "core.hooksPath=/dev/null", "-C", str(ctx.copy), "ls-remote", "--heads",
                                  "origin", "main", "laptop-pause"], 40)
    if code != 0:
        return [Result("install.remote-main", WARN, "could not reach GitHub ({})".format((err or "no message").strip()[:80]),
                       "check the network and `gh auth status`")]
    heads = {line.split("\t")[1]: line.split("\t")[0] for line in listing.splitlines() if "\t" in line}
    _, local, _ = git(ctx, "rev-parse", "--verify", "-q", "refs/remotes/origin/main")
    main = heads.get("refs/heads/main", "")
    if main and local.strip() and main != local.strip():
        out.append(Result("install.remote-main", WARN, "GitHub's main ({}) is ahead of the laptop's last fetch ({})".format(
            main[:7], local.strip()[:7]), "the next follow pass moves the copy; or run laptop/follow.py"))
    else:
        out.append(Result("install.remote-main", PASS, "the laptop has fetched GitHub's latest main"))
    if "refs/heads/laptop-pause" in heads:
        out.append(Result("install.pause-branch", FAIL, "a laptop-pause branch exists on GitHub: installs are paused",
                          "delete the laptop-pause branch on GitHub to resume"))
    return out


@check("install", "jobs-file")
def jobs_file(ctx: Ctx) -> Result:
    jobs = ctx.jobs()
    if isinstance(jobs, str):
        return Result("install.jobs-file", FAIL, "jobs.yaml: " + jobs, "fix jobs.yaml in a cloud session and merge")
    return Result("install.jobs-file", PASS, "jobs.yaml lists {} jobs".format(len(jobs)))


@check("jobs", "recurring")
def recurring_jobs(ctx: Ctx) -> List[Result]:
    jobs, state = ctx.jobs(), ctx.job_state()
    if isinstance(jobs, str) or state is None:
        return [Result("jobs.state", FAIL, "cannot judge the jobs: jobs.yaml or jobs-state.json is unreadable",
                       "fix install.jobs-file and install.follow-ran first")]
    out: List[Result] = []
    for job in jobs:
        jid, every = str(job["id"]), job["every"]
        if every is None or jid in ("follow", "doctor"):  # follow has its own check; the doctor job is this report
            continue
        cid = "jobs." + jid
        record = state.get(jid) or {}
        log = "read ~/.josh-360/logs/{}.log".format(jid)
        if not record:
            out.append(Result(cid, WARN, "has not run yet (runs every {} min)".format(int(every) // 60),
                              "wait for the next runner pass, or: python3 ~/.josh-360/repo/laptop/run_jobs.py"))
            continue
        age = ctx.age_seconds(float(record.get("last_run", 0) or 0))
        if record.get("last_result") != 0:
            out.append(Result(cid, FAIL, "last run {} exited {}".format(ago(age), record.get("last_result")), log))
        elif age > OVERDUE_FACTOR * float(every) + OVERDUE_SLACK_SECONDS:
            out.append(Result(cid, WARN, "last ran {}; it is due every {} min".format(ago(age), int(every) // 60),
                              "check install.runner-launchd and that the laptop was awake"))
        else:
            out.append(Result(cid, PASS, "ran {}, exit 0".format(ago(age))))
    return out


def ledger_count(ctx: Ctx, table: str) -> int:
    """Rows in one ledger table, or -1 when the ledger cannot be read. Counts only; no row is read."""
    path = ctx.state / "ledger.db"
    try:
        conn = ctx.sqlite_ro(path)
        try:
            return int(conn.execute("SELECT count(*) FROM {}".format(table)).fetchone()[0])
        finally:
            conn.close()
    except Exception:  # noqa: BLE001  (unreadable is "unknown")
        return -1


def _archive_has(ctx: Ctx, name: str) -> bool:
    base = ctx.user_home / "Archive" / "josh-360-retired"
    return base.is_dir() and any(base.glob("*/" + name + "*"))


# once-job id -> (what to look for as evidence that it really did its work, function(ctx) -> (ok, text))
def _evidence(ctx: Ctx, jid: str):
    if jid == "ledger-backfill":
        n = ledger_count(ctx, "sessions")
        return (n > 0, "{} sessions in the ledger".format(n)) if n >= 0 else (False, "the ledger cannot be read")
    if jid == "ledger-friction-catchup":
        n = ledger_count(ctx, "session_facts")
        return (n > 0, "{} friction facts in the ledger".format(n)) if n >= 0 else (False, "the ledger cannot be read")
    if jid == "retire-session-atlas":
        ok = _archive_has(ctx, "session-atlas")
        return ok, ("the old Atlas is archived under ~/Archive/josh-360-retired/" if ok else
                    "no archive of the old Atlas under ~/Archive/josh-360-retired/")
    return True, ""


@check("backfills", "once-jobs")
def once_jobs(ctx: Ctx) -> List[Result]:
    jobs, state = ctx.jobs(), ctx.job_state()
    if isinstance(jobs, str) or state is None:
        return [Result("backfills.state", FAIL, "cannot judge the one-time jobs: jobs.yaml or jobs-state.json is unreadable",
                       "fix install.jobs-file and install.follow-ran first")]
    out: List[Result] = []
    for job in jobs:
        jid = str(job["id"])
        if job["every"] is not None:
            continue
        cid = "backfills." + jid
        record = state.get(jid) or {}
        log = "read ~/.josh-360/logs/{}.log".format(jid)
        dep = DEPENDS.get(jid)
        dep_ok = dep is None or (state.get(dep) or {}).get("last_result") == 0
        if record.get("last_result") == 0:
            ok, text = _evidence(ctx, jid)
            if ok:
                out.append(Result(cid, PASS, "succeeded {}{}".format(ago(ctx.age_seconds(float(record.get("last_run", 0) or 0))),
                                                                     "; " + text if text else "")))
            else:
                out.append(Result(cid, WARN, "reported success but {}".format(text), log))
        elif not record:
            out.append(Result(cid, WARN, "has not run yet" + ("" if dep_ok else " (waits for {})".format(dep)),
                              "wait for the next runner pass, or: python3 ~/.josh-360/repo/laptop/run_jobs.py"))
        elif not dep_ok:
            out.append(Result(cid, WARN, "waiting for {} to succeed first (retries hourly)".format(dep), log))
        else:
            out.append(Result(cid, FAIL, "last try {} exited {}; it retries hourly".format(
                ago(ctx.age_seconds(float(record.get("last_run", 0) or 0))), record.get("last_result")), log))
    return out
