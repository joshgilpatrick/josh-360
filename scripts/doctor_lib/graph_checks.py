"""The graphs' checks. JP-167: the validation start rule is on, and no watch has run past its give-up time. JP-174: no
graph worktree has outlived its ticket's last run by more than seven days. JP-191: no finished step's session is open. Reads the laptop copy's
`graphs/runner/starts.json` and `conventions/registry.json`, the ledger (read-only), the run folders' watch files and the
registered clones' `.claude/worktrees/` folders. It writes nothing, and what it prints is a run id, a ticket key, a
worktree's folder name and its clone's path."""
from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import List, Optional

sys.dont_write_bytecode = True
from .core import FAIL, PASS, SKIP, WARN, Ctx, Result, check  # noqa: E402

GRACE = timedelta(days=1)       # a closed laptop takes no checks, so a watch is late only a day after its time
ROUND_FILE = re.compile(r"^round-(\d+)\.json$")
OPEN_VALIDATION_RUNS = ("SELECT r.run_id, r.ticket_key FROM graph_runs r WHERE r.graph_id = 'validation' "
                        "AND NOT EXISTS (SELECT 1 FROM run_ends e WHERE e.run_id = r.run_id) ORDER BY r.id")


def _when(text) -> Optional[datetime]:
    if not isinstance(text, str) or not text:
        return None
    try:
        return datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _lines(path: Path) -> List[dict]:
    try:
        raw = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []
    found = []
    for line in raw:
        try:
            parsed = json.loads(line)
        except ValueError:
            continue
        if isinstance(parsed, dict):
            found.append(parsed)
    return found


def _due(folder: Path) -> Optional[datetime]:
    """When the run's newest watch is due to give up, or None: no watch file, it has ended, or it has not begun."""
    rounds = []
    if folder.is_dir():
        rounds = sorted((int(m.group(1)), p) for p in folder.iterdir() for m in [ROUND_FILE.fullmatch(p.name)] if m)
    if not rounds:
        return None
    path = rounds[-1][1]
    try:
        plan = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(plan, dict):
        return None
    lines = _lines(path.with_name(path.stem + ".checks.jsonl"))
    if any(line.get("kind") == "end" for line in lines):
        return None
    began = [line for line in lines if line.get("kind") == "began"]
    begins = _when(plan.get("begins_at")) or (_when(began[-1].get("at")) if began else None)
    days = plan.get("give_up_days")
    if begins is None or not isinstance(days, int) or isinstance(days, bool):
        return None
    return begins + timedelta(days=days)


@check("graphs", "validation-watch")
def validation_watch(ctx: Ctx) -> Result:
    cid = "graphs.validation-watch"
    try:
        rules = json.loads((ctx.copy / "graphs" / "runner" / "starts.json").read_text(encoding="utf-8"))["graphs"]
        rule = rules.get("validation")
    except (OSError, ValueError, KeyError, AttributeError):
        return Result(cid, FAIL, "graphs/runner/starts.json cannot be read in the laptop's copy",
                      "python3 ~/.josh-360/repo/laptop/follow.py")
    if not isinstance(rule, dict) or rule.get("on") is not True:
        return Result(cid, FAIL, "the validation graph's start rule is {} in graphs/runner/starts.json, so no ticket in "
                      "Deployed is watched".format("off" if isinstance(rule, dict) else "missing"),
                      'set "on": true on the "validation" rule in graphs/runner/starts.json (in a cloud session, then merge)')
    try:
        conn = ctx.sqlite_ro(ctx.state / "ledger.db")
        try:
            runs = conn.execute(OPEN_VALIDATION_RUNS).fetchall()
        finally:
            conn.close()
    except Exception as err:  # noqa: BLE001  (a missing, locked or damaged ledger is one answer here: cannot be read)
        return Result(cid, SKIP, "the ledger cannot be read ({}), so open watches are not checked".format(
            type(err).__name__))
    runs_dir = Path(ctx.env.get("JOSH360_RUNS") or str(ctx.home / "runs"))
    late = []
    for run_id, ticket in runs:
        due = _due(runs_dir / str(run_id) / "work" / "watch")
        if due is not None and ctx.now > due + GRACE:
            late.append("{} ({})".format(run_id, ticket))
    if late:
        return Result(cid, FAIL, "{} watch(es) are more than a day past their give-up time: {}".format(
            len(late), "; ".join(late)),
            "read the run with `python3 ~/.josh-360/repo/graphs/runner/runner.py report --run <id>`; a watch that is "
            "stuck is a bug to report")
    return Result(cid, PASS, "rule on; {} watches open, none overdue".format(len(runs)))


# -- JP-174: a graph's worktree left behind -------------------------------------------------------------------------

STALE_AFTER = timedelta(days=7)
TICKET_TREE = re.compile(r"^([A-Z][A-Z0-9]*-[0-9]+)-.+$")     # .claude/worktrees/<KEY>-<slug>, as prepare-worktree makes
TICKET_HAS_OPEN_RUN = ("SELECT 1 FROM graph_runs g WHERE g.ticket_key = ? AND NOT EXISTS "
                       "(SELECT 1 FROM run_ends e WHERE e.run_id = g.run_id) LIMIT 1")
TICKET_LAST_END = ("SELECT MAX(e.ended_at), COUNT(g.run_id) FROM graph_runs g LEFT JOIN current_run_ends e "
                   "ON e.run_id = g.run_id WHERE g.ticket_key = ?")


def _clones(ctx: Ctx) -> Optional[List[Path]]:
    """The registered clones that exist (the registry's `folders`, `~` read against the user's home), each once; None
    when the laptop copy's registry cannot be read."""
    try:
        systems = json.loads((ctx.copy / "conventions" / "registry.json").read_text(encoding="utf-8"))["systems"]
    except (OSError, ValueError, KeyError, TypeError):
        return None
    found: List[Path] = []
    for system in systems if isinstance(systems, list) else []:
        for folder in (system.get("folders") or []) if isinstance(system, dict) else []:
            if not isinstance(folder, str):
                continue
            path = ctx.user_home / folder[2:] if folder.startswith("~/") else Path(folder)
            if path.is_dir() and path.resolve() not in [p.resolve() for p in found]:
                found.append(path)
    return found


@check("graphs", "stale-worktrees")
def stale_worktrees(ctx: Ctx) -> Result:
    """WARN for each `.claude/worktrees/<KEY>-*` worktree in a registered clone whose ticket has no open run and whose
    last run ended more than seven days ago. A worktree no graph run made (its ticket never ran) is not the graphs'."""
    cid = "graphs.stale-worktrees"
    clones = _clones(ctx)
    if clones is None:
        return Result(cid, WARN, "conventions/registry.json cannot be read in the laptop's copy, so worktrees were not "
                      "looked for", "python3 ~/.josh-360/repo/laptop/follow.py")
    trees = []
    for clone in clones:
        folder = clone / ".claude" / "worktrees"
        if folder.is_dir():
            for path in sorted(folder.iterdir()):
                found = TICKET_TREE.match(path.name)
                if found and path.is_dir():
                    trees.append((found.group(1), clone, path))
    if not trees:
        return Result(cid, PASS, "no graph worktrees in {} registered clone(s)".format(len(clones)))
    try:
        conn = ctx.sqlite_ro(ctx.state / "ledger.db")
    except Exception as err:  # noqa: BLE001  (a missing or damaged ledger: the runs cannot be read)
        return Result(cid, WARN, "the ledger cannot be read ({}), so {} worktree(s) were not checked".format(
            type(err).__name__, len(trees)), "python3 ~/.josh-360/repo/scripts/doctor.py (its ledger checks say why)")
    stale = []
    try:
        for key, clone, path in trees:
            if conn.execute(TICKET_HAS_OPEN_RUN, (key,)).fetchone():
                continue                    # a run is still using it, stopped runs included: `where` says so
            last, runs = conn.execute(TICKET_LAST_END, (key,)).fetchone()
            ended = _when(last)
            if not runs or ended is None or ctx.now - ended <= STALE_AFTER:
                continue
            stale.append("{} in {} (last run ended {})".format(path.name, ctx.tilde(clone), last[:10]))
    finally:
        conn.close()
    if stale:
        return Result(cid, WARN, "{} graph worktree(s) outlived their run by more than 7 days: {}".format(
            len(stale), "; ".join(stale)),
            "run /closeout (python3 ~/.josh-360/repo/ledger/closeout.py) to see what each holds; nothing is removed "
            "without Josh")
    return Result(cid, PASS, "{} graph worktree(s), none left more than 7 days after its run".format(len(trees)))


TICKET_ROOT = "josh-360/tickets/"
NAME = re.compile(r"^(?P<key>[A-Z][A-Z0-9]*-\d+)\((?P<letter>[a-z]+)\) - \S.*$")


def _am_db(ctx: Ctx) -> Path:
    named = ctx.env.get("JOSH360_AM_DB")
    return Path(named) if named else ctx.user_home / "Library" / "Application Support" / "agent-manager" / "state.db"


def _am_rows(ctx: Ctx) -> list:
    """(id, name, group_name, archived, status) for every session in Agent Manager's database. `status` is None when
    the table has no such column. Raises when the database cannot be read."""
    conn = ctx.sqlite_ro(_am_db(ctx))
    try:
        columns = {r[1] for r in conn.execute("PRAGMA table_info(sessions)")}
        status = "status" if "status" in columns else "NULL"
        return conn.execute("SELECT id, name, group_name, archived, {} FROM sessions".format(status)).fetchall()
    finally:
        conn.close()


def _open(row) -> bool:
    """Open: neither archived nor killed (`dead`, JP-191). A killed session keeps its row but is closed."""
    return not row[3] and row[4] != "dead"


@check("graphs", "agent-manager-groups")
def agent_manager_groups(ctx: Ctx) -> Result:
    """JP-173: each ticket's kept session is the only one in view, is named `<KEY>(<letter>) - <Step>`, and sits in the
    group for the status the runner last saw. Reads the runner's `state/runner/am-tickets.json` and Agent Manager's
    database, read-only; never Jira, so the offline daily job can pass. Nothing in view is a skip, not a pass."""
    cid = "graphs.agent-manager-groups"
    path = ctx.state / "runner" / "am-tickets.json"
    try:
        tickets = json.loads(path.read_text(encoding="utf-8"))["tickets"] if path.is_file() else {}
        if not isinstance(tickets, dict):
            raise ValueError("tickets is not an object")
    except (OSError, ValueError, KeyError, TypeError) as err:
        return Result(cid, FAIL, "the runner's {} cannot be read ({})".format(ctx.tilde(path), type(err).__name__),
                      "look at the file; the runner rewrites it on its next tick only when it can read it")
    try:
        rows = _am_rows(ctx)
    except Exception as err:  # noqa: BLE001  (a missing, locked or changed database is one answer: cannot be read)
        return Result(cid, SKIP, "Agent Manager's database cannot be read ({})".format(type(err).__name__))
    by_id = {r[0]: r for r in rows}
    problems, shown, known = [], 0, set()
    for key in sorted(tickets):
        rec = tickets[key] if isinstance(tickets[key], dict) else {}
        sessions = [s for s in rec.get("sessions") or [] if isinstance(s, dict)]
        known.update(s.get("am_session") for s in sessions)
        live = [by_id[s["am_session"]] for s in sessions if s.get("am_session") in by_id
                and _open(by_id[s["am_session"]]) and s.get("finished_at") is None]   # JP-191: closed ones are not
        if not live:
            continue
        shown += 1
        if len(live) > 1:
            problems.append("{} has {} sessions in view".format(key, len(live)))
        for row in live:
            match = NAME.match(row[1] or "")
            if not match or match.group("key") != key:
                problems.append("{}'s session {} is not named {}(<letter>) - <Step>".format(key, row[0], key))
            if rec.get("group") and row[2] != rec["group"]:
                problems.append("{}'s session {} is in '{}', not '{}'".format(key, row[0], row[2] or "(root)", rec["group"]))
    for row in rows:
        if _open(row) and str(row[2] or "").startswith(TICKET_ROOT) and row[0] not in known:
            problems.append("session {} is in '{}' but the runner has no record of it".format(row[0], row[2]))
    if problems:
        return Result(cid, FAIL, "; ".join(problems[:5]) + ("" if len(problems) <= 5 else " (and {} more)".format(
            len(problems) - 5)), "the runner's next tick moves and archives what it can; read "
            "~/.josh-360/logs/runner/runner.log for an Agent Manager call that keeps failing")
    if not shown:
        return Result(cid, SKIP, "no ticket has a graph session in view, so there is nothing to check")
    return Result(cid, PASS, "{} ticket(s) in view, each with one session in its status group".format(shown))


COMPLETED = "josh-360/completed-steps"
DONE_GROUP = TICKET_ROOT + "Done"


def _runner_number(ctx: Ctx, name: str, default: float) -> float:
    """A number from the laptop copy's `graphs/runner/settings.json`, else the runner's own default."""
    try:
        doc = json.loads((ctx.copy / "graphs" / "runner" / "settings.json").read_text(encoding="utf-8"))
        return float(doc.get(name, default))
    except (OSError, ValueError, TypeError, AttributeError):
        return default


@check("graphs", "completed-step-sessions")
def completed_step_sessions(ctx: Ctx) -> Result:
    """JP-191: no finished step's session is still open. Each ticket session whose result the runner recorded
    (`finished_at` in `state/runner/am-tickets.json`) is killed or archived in Agent Manager, and an unarchived one sits
    in `josh-360/completed-steps` (or, for a ticket's last session, `josh-360/tickets/Done`). A session is judged only
    once the runner has had its kill wait (`kill_grace_seconds`) and two ticks. Reads the runner's file and Agent
    Manager's database, read-only; never Jira. No finished session yet passes: nothing is left open."""
    cid = "graphs.completed-step-sessions"
    path = ctx.state / "runner" / "am-tickets.json"
    try:
        tickets = json.loads(path.read_text(encoding="utf-8"))["tickets"] if path.is_file() else {}
        if not isinstance(tickets, dict):
            raise ValueError("tickets is not an object")
    except (OSError, ValueError, KeyError, TypeError) as err:
        return Result(cid, FAIL, "the runner's {} cannot be read ({})".format(ctx.tilde(path), type(err).__name__),
                      "look at the file; the runner rewrites it on its next tick only when it can read it")
    try:
        rows = {r[0]: r for r in _am_rows(ctx)}
    except Exception as err:  # noqa: BLE001
        return Result(cid, SKIP, "Agent Manager's database cannot be read ({})".format(type(err).__name__))
    wait = _runner_number(ctx, "kill_grace_seconds", 1800) + 2 * _runner_number(ctx, "tick_seconds", 300)
    problems, judged = [], 0
    for key in sorted(tickets):
        rec = tickets[key] if isinstance(tickets[key], dict) else {}
        for s in rec.get("sessions") or []:
            if not isinstance(s, dict) or s.get("finished_at") is None or s.get("am_session") not in rows:
                continue
            try:
                age = ctx.age_seconds(float(s["finished_at"]))
            except (TypeError, ValueError):
                problems.append("{}'s session {} has an unreadable finish time".format(key, s.get("am_session")))
                continue
            if age < wait:
                continue
            judged += 1
            row = rows[s["am_session"]]
            if row[3]:
                continue
            if row[4] != "dead":
                problems.append("{}'s session {} finished its step but is still running".format(key, row[0]))
            elif row[2] not in (COMPLETED, DONE_GROUP):
                problems.append("{}'s finished session {} is in '{}', not '{}'".format(
                    key, row[0], row[2] or "(root)", COMPLETED))
    if problems:
        return Result(cid, FAIL, "; ".join(problems[:5]) + ("" if len(problems) <= 5 else " (and {} more)".format(
            len(problems) - 5)), "the runner's next tick kills and files what it can; read "
            "~/.josh-360/logs/runner/runner.log for an Agent Manager kill or move that keeps failing")
    if not judged:
        return Result(cid, PASS, "no finished step's session is old enough to judge, so none is left open")
    return Result(cid, PASS, "{} finished step session(s), each killed or archived".format(judged))


class _Asked:
    """What `subprocess.run` would return, for a keychain question asked without reading the secret."""

    def __init__(self, code: int):
        self.returncode = code
        self.stdout = "present" if code == 0 else ""


def _gate_jira_names(ctx: Ctx):
    """The names the walker would hand a gate, built by the walker's own `jira_env` (JP-171). The keychain is asked
    whether the item exists (`-w` removed), so the token is never read; the answer stands in for it."""
    tools = str(Path(__file__).resolve().parent.parent.parent / "graphs" / "tools")
    if tools not in sys.path:
        sys.path.insert(0, tools)
    from walker_lib import gates  # noqa: E402  (the walker's code, so the doctor sees what a gate would get)
    asked = {}

    def ask(argv, **kwargs):
        code, _, _ = ctx.run([a for a in argv if a != "-w"], 15)
        asked["code"] = code
        return _Asked(code)
    return set(gates.jira_env(ctx.env, run=ask, state=ctx.state)), asked.get("code")


@check("graphs", "gate-jira")
def gate_jira(ctx: Ctx) -> Result:
    cid = "graphs.gate-jira"
    names, keychain = _gate_jira_names(ctx)
    if "JOSH360_JIRA_EMAIL" not in names:
        return Result(cid, FAIL, "the walker finds no Jira email to give gate scripts, so every gate that reads Jira "
                      "stops and runs are not admitted",
                      "put your Atlassian email on one line in ~/.josh-360/state/jira-email "
                      "(or: doctor --fix --jira-email you@example.com)", "jira-email")
    if "JOSH360_JIRA_TOKEN" not in names:
        if keychain in (124, 127):
            return Result(cid, SKIP, "the email is found; the keychain cannot be asked here (not a Mac)")
        return Result(cid, FAIL, "the walker finds no Jira token to give gate scripts, so every gate that reads Jira "
                      "stops and runs are not admitted",
                      "add the Atlassian API token to the login keychain as generic password jira-claude-api-key "
                      "(any account name)")
    return Result(cid, PASS, "gate scripts get both the Jira email and the token")
