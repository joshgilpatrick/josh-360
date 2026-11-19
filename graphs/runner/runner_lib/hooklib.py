"""The logic of the four hooks that put the rails on a graph step's session (JP-117). Python 3.9, standard library only.

The hook files in `hooks/<Event>/20-graph-step*` are thin wrappers that call `main(event)`; tests call the functions in
process. Every function takes the event's JSON payload, the environment and the time, and returns a `Result`: the exit
code (0 carry on, 2 block), what to print on standard output and what to print on standard error. A session with no
entry file in `graph-sessions/` is not a graph session, and every function returns `(0, "", "")` for it before reading
anything else: the rails act on the runner's sessions and on no other.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Callable, Dict, Optional, Tuple

from . import gitrail, paths, sessionfile
from ledger import graph_sessions, spool  # noqa: E402
from walker_lib import runfolder  # noqa: E402

Result = Tuple[int, str, str]
NOTHING: Result = (0, "", "")
MARKER = re.compile(r"^\[josh360-step run=(r-[0-9a-z]+) step=([a-z0-9_]+) attempt=([0-9]+) key=([0-9a-f]{16})\]\s*$", re.M)
Unreadable = sessionfile.Unreadable


def marker(run: str, step: str, attempt: int, key: str) -> str:
    return "[josh360-step run={} step={} attempt={} key={}]".format(run, step, attempt, key)


def _write(path: Path, doc: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(doc, sort_keys=True), encoding="utf-8")
    os.replace(str(tmp), str(path))


def entry(session_id: object) -> Optional[dict]:
    """The session's graph-session entry; None when it has none; Unreadable when the file is there and cannot be read."""
    try:
        path = graph_sessions.entry_path(session_id)   # type: ignore[arg-type]
    except ValueError:
        return None
    if not path.is_file():
        return None
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as err:
        raise Unreadable("{}: {}".format(path.name, err))
    if not isinstance(doc, dict):
        raise Unreadable("{} is not an object".format(path.name))
    return doc


def link(payload: dict, environ: dict, now: float) -> Result:
    """Make this session a graph session when its first prompt carries the runner's marker for an unlinked step."""
    session_id = payload.get("session_id")
    prompt = payload.get("prompt")
    if not isinstance(session_id, str) or not spool.SESSION_ID.match(session_id) or not isinstance(prompt, str):
        return NOTHING
    found = MARKER.search(prompt)
    if not found:
        return NOTHING
    if graph_sessions.entry_path(session_id).exists():
        return NOTHING
    run, step, attempt, key = found.group(1), found.group(2), int(found.group(3)), found.group(4)
    try:
        folder = runfolder.folder(run)
    except ValueError:
        return NOTHING
    if not folder.is_dir():
        return NOTHING
    doc = sessionfile.read(run, step, attempt)
    if not doc or doc.get("state") not in sessionfile.LIVE or doc.get("key") != key:
        return NOTHING
    if sessionfile.link_path(run, step, attempt).exists():
        return NOTHING
    am_session = environ.get("AGENT_MANAGER_SESSION_ID") or None
    _write(sessionfile.link_path(run, step, attempt), {"session_id": session_id, "am_session": am_session, "linked_at": now})
    keys = ("run", "step", "attempt", "graph", "ticket", "access", "tier", "outcomes", "result_file", "work_dir")
    made = {k: doc.get(k) for k in keys}
    made.update(run_folder=str(folder), started_at=now, am_session=am_session, nudged_at=None)
    _write(graph_sessions.entry_path(session_id), made)
    return NOTHING


# -- the guard -----------------------------------------------------------------------------------------------------

SECRET_NAME = re.compile(r"(^|[/\s'\"=:])\.env(\.[A-Za-z0-9_-]+)?($|[\s'\";|&)])")
SECRET_PARTS = ("credentials", ".aws/", ".ssh/", ".config/gh/hosts.yml", ".netrc", "library/keychains/")
FILE_WORDS = re.compile(r"(?<![\w./-])(tee|rm|mv|cp|ln|touch|mkdir|chmod|truncate|dd|install)(?![\w./-])|\bsed\s+-i\b")
INTERPRETERS = re.compile(r"(?<![\w./-])(python3?|node|perl|ruby)(?![\w-])")
HARMLESS_REDIRECTS = re.compile(r"\d*>&\d+|&?>>?\s*/dev/null|\d+>>?\s*/dev/null")
GIT_WRITES = re.compile(r"\bgit\s+(?:-\S+\s+)*(commit|push|add|merge|rebase|reset|stash|tag|cherry-pick|revert|apply|am)\b")
GH_READ = re.compile(r"^(?:(?:pr|issue|repo|run|release|workflow)\s+(?:view|list|diff|checks|status|watch)\b|search\b|auth\s+status\b)")
GH_API_WRITE = re.compile(r"(?:^|\s)(?:-X|--method|-f|-F|--field|--raw-field|--input)(?:\s|=|$)")
COMMAND_START = r"(?:^|[;&|(\n]|\$\()\s*(?:(?:env|command|exec)\s+(?:[A-Za-z_]\w*=\S*\s+)*)?"
JIRA_WORDS = re.compile(r"\b(create|edit|update|transition|comment|assign|delete|link|move|archive|attach)\b")
JIRA_READ_PREFIXES = ("get", "search", "list", "discover", "executeread", "atlassian")


def _deny(message: str) -> Result:
    return (2, "", message)


def _reads_only() -> Result:
    return _deny("this step only reads: write nothing but your result and files in the work folder")


def _expand(path: str) -> str:
    return os.path.realpath(os.path.expanduser(path))


def _is_secret(text: str) -> bool:
    lowered = text.lower()
    return bool(SECRET_NAME.search(text)) or any(part in lowered for part in SECRET_PARTS)


def calls(session_id: str) -> int:
    path = graph_sessions.folder() / (session_id + ".calls")
    try:
        return path.stat().st_size
    except OSError:
        return 0


def _count_call(session_id: str) -> int:
    path = graph_sessions.folder() / (session_id + ".calls")
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(str(path), "ab") as handle:
        handle.write(b".")
    return calls(session_id)


def _runs_dir() -> Path:
    return runfolder.runs_dir()


def _home() -> Path:
    from laptop import common
    return common.home()


def _protected(path: str, ent: dict) -> bool:
    """A file path the step may not change: the rails, the ledger, the settings, another run, this run's own files."""
    real = _expand(path)
    result = _expand(ent["result_file"])
    if real == result:
        return False
    home = _home()
    for prefix in (home / "repo", home / "state"):
        # `real` is fully resolved, so the prefix is tried both as written and resolved (a home behind a symlink,
        # such as macOS's /var -> /private/var, would otherwise slip past)
        if _under(real, str(prefix)) or _under(real, str(prefix.resolve())):
            return True
    for name in ("settings.json", "settings.local.json"):
        if real == _expand(os.path.join("~", ".claude", name)):
            return True
    runs = str(_runs_dir().resolve()) if _runs_dir().exists() else str(_runs_dir())
    if _under(real, runs):
        mine = os.path.join(runs, str(ent["run"]))
        if _under(real, mine):
            return not any(_under(real, os.path.join(mine, part)) for part in ("work", "prompts"))
        return True
    return False


def _under(path: str, folder: str) -> bool:
    folder = folder.rstrip("/")
    return path == folder or path.startswith(folder + "/")


def _mentions_protected(text: str, ent: dict) -> bool:
    """Does shell text name a protected path? Both spellings of each prefix are looked for."""
    home = _home()
    prefixes = [str(home / "repo") + "/", str(home / "state") + "/", str(home.resolve() / "repo") + "/",
                str(home.resolve() / "state") + "/"]
    for name in ("settings.json", "settings.local.json"):
        prefixes += [os.path.join("~", ".claude", name), _expand(os.path.join("~", ".claude", name)),
                     os.path.join(os.path.expanduser("~"), ".claude", name)]
    for spelling in ("~", "$HOME", "${HOME}"):                  # the usual ways to write the default home folder
        prefixes += [spelling + "/.josh-360/repo", spelling + "/.josh-360/state"]
    if any(p in text for p in prefixes):
        return True
    runs = _runs_dir()
    for base in {str(runs), str(runs.resolve())}:
        for found in re.finditer(re.escape(base) + r"/?(r-[0-9a-z]+)?([^\s'\";|&<>)]*)", text):
            if found.group(1) is None:
                return True
            if found.group(1) != ent["run"]:
                return True
            rest = found.group(2).lstrip("/")
            if not (rest.startswith("work") or rest.startswith("prompts") or os.path.join(base, found.group(1), rest) == ent["result_file"]):
                return True
    return False


def _writes(command: str) -> bool:
    """A redirect to a file (harmless ones such as 2>&1 and /dev/null are taken out first)."""
    return ">" in HARMLESS_REDIRECTS.sub(" ", command)


def _gh_denied(command: str) -> bool:
    for found in re.finditer(COMMAND_START + r"gh\s+([^;&|\n]*)", command):
        args = found.group(1).strip()
        if GH_READ.match(args):
            continue
        if args.startswith("api") and not GH_API_WRITE.search(args):
            continue
        return True
    return False


def _bash(command: str, ent: dict) -> Optional[Result]:
    if _gh_denied(command):
        return _deny("only gate scripts write to GitHub")
    for found in re.finditer(COMMAND_START + r"(?:jira|acli)\s+([^;&|\n]*)", command):
        if JIRA_WORDS.search(found.group(1)):
            return _deny("only gate scripts write to Jira")
    if re.search(COMMAND_START + r"security\s+(?:find-|dump-|export)", command):
        return _deny("a step session does not read the keychain")
    if _is_secret(command):
        return _deny("a step session does not read secrets")
    if _mentions_protected(command, ent) and (_writes(command) or FILE_WORDS.search(command) or INTERPRETERS.search(command)):
        return _deny("a step session does not change the runner, the ledger or another run")
    return None


def _ticket_tree(ent: dict) -> Tuple[Optional[str], Optional[str]]:
    """The run's branch and worktree, from `prepare-worktree`'s outputs in run.json; (None, None) when it has none."""
    try:
        values = runfolder.values(runfolder.load(str(ent["run"])))
    except (FileNotFoundError, ValueError, OSError):
        return None, None
    branch, tree = values.get("branch"), values.get("worktree")
    return (branch if isinstance(branch, str) else None), (tree if isinstance(tree, str) else None)


def _one_tree(what: str, ent: dict) -> Result:
    branch, tree = _ticket_tree(ent)
    return _deny(gitrail.message(what, ent.get("ticket"), branch, tree, ent.get("work_dir")))


def guard(payload: dict, environ: dict, now: float) -> Result:
    """PreToolUse: deny what a graph step's session must not do. A session with no entry is untouched."""
    session_id = payload.get("session_id")
    if not graph_sessions.is_graph_session(session_id):
        return NOTHING
    try:
        ent = entry(session_id)
    except Unreadable:
        return _deny("graph step guard: this session's run link cannot be read")
    if ent is None:
        return NOTHING
    tool = payload.get("tool_name") or ""
    given = payload.get("tool_input") if isinstance(payload.get("tool_input"), dict) else {}
    target = given.get("file_path") or given.get("notebook_path") or ""
    if tool == "Write" and isinstance(target, str) and target and _expand(target) == _expand(ent["result_file"]):
        return NOTHING
    cfg = paths.settings()
    if _count_call(session_id) > int(cfg["turn_cap"]):
        return _deny("turn cap reached: use the Write tool to write your result with the outcome that fits, then stop")
    if now - float(ent.get("started_at") or now) >= float(cfg["time_cap_seconds"]):
        return _deny("time cap reached: use the Write tool to write your result with the outcome that fits, then stop")
    if tool in gitrail.WORKTREE_TOOLS:
        return _one_tree("a worktree", ent)
    if tool == "AskUserQuestion":
        return _deny("a step session does not ask questions: end with the outcome that says you need input")
    if tool.startswith("mcp__"):
        _, _, rest = tool.partition("mcp__")
        server, _, name = rest.partition("__")
        lowered_server, lowered = server.lower(), name.lower()
        if ("atlassian" in lowered_server or "jira" in lowered_server) and not lowered.startswith(JIRA_READ_PREFIXES):
            return _deny("only gate scripts write to Jira")
        if "github" in lowered_server and not (lowered.startswith(("get_", "list_", "search_")) or lowered.endswith("_read")):
            return _deny("only gate scripts write to GitHub")
    if tool == "Bash":
        command = given.get("command") if isinstance(given.get("command"), str) else ""
        denied = _bash(command, ent)
        if denied:
            return denied
        made = gitrail.refused(command)
        if made:
            return _one_tree(made, ent)
        if ent.get("access") == "read":
            if GIT_WRITES.search(command):
                return _reads_only()
            if (_writes(command) or FILE_WORDS.search(command)) and ent["work_dir"] not in command \
                    and ent["result_file"] not in command:
                return _reads_only()
        return NOTHING
    if tool in ("Read", "Grep", "Glob"):
        texts = [v for v in given.values() if isinstance(v, str)]
        if any(_is_secret(t) for t in texts):
            return _deny("a step session does not read secrets")
        return NOTHING
    if tool in ("Write", "Edit", "NotebookEdit"):
        if isinstance(target, str) and target:
            if _protected(target, ent):
                return _deny("a step session does not change the runner, the ledger or another run")
            if ent.get("access") == "read" and not _under(_expand(target), _expand(ent["work_dir"])):
                return _reads_only()
    return NOTHING


def reflect(payload: dict, environ: dict, now: float) -> Result:
    """PostToolUse: every `reflect_every` tool calls, once, ask the session whether it is looping."""
    session_id = payload.get("session_id")
    if not graph_sessions.is_graph_session(session_id):
        return NOTHING
    try:
        if entry(session_id) is None:
            return NOTHING
    except Unreadable:
        return NOTHING
    every = max(1, int(paths.settings()["reflect_every"]))
    n = calls(session_id)
    marker_path = graph_sessions.folder() / (session_id + ".reflected")
    try:
        done = int(marker_path.read_text() or 0)
    except (OSError, ValueError):
        done = 0
    if n // every <= done:
        return NOTHING
    marker_path.write_text(str(n // every))
    text = ("Josh 360 graph step: you have made {} tool calls. Are you looping? Reassess, and if you are stuck, end with "
            "the outcome that says so.").format(n)
    return (0, json.dumps({"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": text}}) + "\n", "")


def stop(payload: dict, environ: dict, now: float) -> Result:
    """Stop: pass waiting ticket comments on, and nudge once when the step ends without its result. Never blocks twice."""
    session_id = payload.get("session_id")
    if not graph_sessions.is_graph_session(session_id):
        return NOTHING
    if payload.get("stop_hook_active"):
        return NOTHING
    try:
        ent = entry(session_id)
    except Unreadable:
        return NOTHING
    if ent is None or Path(ent["result_file"]).exists():
        return NOTHING
    from ledger import comments
    text = comments.take_run(ent["run"])
    if text:
        return (2, "", text)
    if ent.get("nudged_at") is None:
        ent["nudged_at"] = now
        _write(graph_sessions.entry_path(session_id), ent)
        return (2, "", "Write your result to {} with one of these outcomes: {}. Use the Write tool, then stop."
                .format(ent["result_file"], ", ".join(ent["outcomes"])))
    return NOTHING


FUNCTIONS: Dict[str, Callable[[dict, dict, float], Result]] = {"UserPromptSubmit": link, "PreToolUse": guard,
                                                              "PostToolUse": reflect, "Stop": stop}


def main(event: str) -> int:
    """What a hook file calls: read the payload, run the event's function, print its result, return the exit code.
    An exception exits 2 when the session has an entry file (a graph session is denied, not waved through) and 0
    when it has none."""
    session_id = None
    try:
        payload = json.loads(sys.stdin.read())
        session_id = payload.get("session_id") if isinstance(payload, dict) else None
        function = FUNCTIONS.get(event)
        if function is None or not isinstance(payload, dict):
            return 0
        code, out, err = function(payload, dict(os.environ), time.time())
        if out:
            sys.stdout.write(out)
        if err:
            sys.stderr.write(err)
        return code
    except Exception as exc:  # noqa: BLE001
        if graph_sessions.is_graph_session(session_id):
            sys.stderr.write("graph step hook failed ({}): this session's rails could not be checked\n".format(
                type(exc).__name__))
            return 2
        return 0
