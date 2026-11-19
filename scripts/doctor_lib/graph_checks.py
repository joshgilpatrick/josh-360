"""The graphs' checks. JP-167: the validation start rule is on, and no watch has run past its give-up time. JP-174: no
graph worktree has outlived its ticket's last run by more than seven days. Reads the laptop copy's
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
