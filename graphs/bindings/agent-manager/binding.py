"""The Agent Manager binding (JP-117): starts one Agent Manager session for a graph step, reads its state, files it away.

Python 3.9, standard library only. It builds the session's prompt from the walker's `run` answer alone and holds no
graph logic; it imports nothing of the walker, the ledger or the runner. The runner loads it by path
(`graphs/bindings/<runner>/binding.py`).

Every `agent-manager` call runs with the folder of Claude Code first on the PATH, because a laptop job's PATH has no
`~/.local/bin` and Agent Manager then refuses the spawn with "claude is not installed" (the JP-117 probe's first report).
"""
from __future__ import annotations

import json
import os
import re
import shutil
import sqlite3
import subprocess
from pathlib import Path
from typing import Dict, List, Optional, Tuple

NAME = "agent-manager"
TIMEOUT = 120
SEARCH_DIRS = (".local/bin", "bin", ".cargo/bin")
SYSTEM_DIRS = ("/opt/homebrew/bin", "/usr/local/bin")
FIXED = ("You are a step in a graph run. Do not ask questions in this session: end with the outcome that says you "
         "need input. Do not write to Jira or GitHub; gate scripts do that.")
FOLLOW_UPS = ('If you find work outside this ticket, do not do it: report it in the same result file as "follow_ups": '
              '[{"summary": "<one line>", "why": "<why it is outside this ticket>", "blocks": true|false}] (at most 5; '
              '"blocks" is true only when this ticket cannot be finished without it). A script files each one as a '
              "ticket and tells the lead (graphs/contracts/follow-up.md).")


class SpawnRefused(Exception):
    """A session could not be started. `str(err)` is the reason code: no-cli, bad-model, bad-effort, no-folder,
    not-running, rate-limited, network, group, refused, timeout or no-id (JP-183 sorts each into a kind in
    laptop/failure_kinds.py). `detail` is Agent Manager's own message, unshortened; the runner shortens and screens it."""

    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(code)
        self.code = code
        self.detail = detail


FALLBACK_ON = ("bad-model", "bad-effort", "rate-limited")   # refusals for which the tier's next entry is tried

# What Agent Manager's message says, read in this order (JP-183). A message that matches none is `refused`.
_SAYS = (
    ("no-cli", re.compile(r"is not installed|command not found")),
    ("bad-model", re.compile(r"\bmodel\b[^\n]*\b(is not one|not one .* lists|unknown|not supported|unsupported|invalid|"
                             r"not (a )?valid|not recogni[sz]ed|no such)|unknown model|invalid model")),
    ("bad-effort", re.compile(r"\beffort\b[^\n]*\b(is not one|not one .* lists|unknown|not supported|unsupported|invalid|"
                              r"not (a )?valid|not recogni[sz]ed|no such)|unknown effort|invalid effort")),
    ("no-folder", re.compile(r"(directory|folder)[^\n]*(does not exist|doesn't exist|not found|no such)|"
                             r"no such file or directory")),
    ("not-running", re.compile(r"not running|is it running|connection refused|could not connect|cannot connect|"
                               r"failed to connect")),
    ("rate-limited", re.compile(r"rate.?limit|too many requests|\b429\b|overloaded")),
    ("network", re.compile(r"network|temporarily unavailable|connection reset|timed out|name resolution")),
)


def classify(text: str) -> str:
    """The reason code for a refused spawn, from what Agent Manager printed."""
    low = str(text or "").lower()
    for code, pattern in _SAYS:
        if pattern.search(low):
            return code
    return "refused"


def inputs() -> dict:
    """What a spawn depends on outside the run: this binding's settings and where the two commands are found. The
    runner hashes it to tell when a failure that needs a fix may have been fixed (JP-183)."""
    try:
        cfg = config()
    except (OSError, ValueError):
        cfg = None
    return {"config": cfg, "agent_manager": _find("agent-manager", "JOSH360_AM_BIN"),
            "claude": _find("claude", "JOSH360_CLAUDE_BIN")}


def config() -> dict:
    path = Path(os.environ.get("JOSH360_AM_BINDING_JSON") or (Path(__file__).resolve().parent / "binding.json"))
    return json.loads(path.read_text(encoding="utf-8"))


def _find(name: str, env_var: str) -> Optional[str]:
    """An executable: the environment variable's path, else the PATH, else the usual folders."""
    named = os.environ.get(env_var)
    if named:
        return named if os.access(named, os.X_OK) else None
    found = shutil.which(name)
    if found:
        return found
    home = os.path.expanduser("~")
    for folder in [os.path.join(home, d) for d in SEARCH_DIRS] + list(SYSTEM_DIRS):
        candidate = os.path.join(folder, name)
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def _env() -> Dict[str, str]:
    env = dict(os.environ)
    claude = _find("claude", "JOSH360_CLAUDE_BIN")
    if claude:
        env["PATH"] = os.path.dirname(claude) + os.pathsep + env.get("PATH", "")
    return env


def _run(argv: List[str], timeout: int = TIMEOUT) -> Tuple[int, str, str]:
    done = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          universal_newlines=True, timeout=timeout, env=_env())
    return done.returncode, done.stdout, done.stderr


def step_title(step: str) -> str:
    return " ".join(w.capitalize() for w in str(step).split("_"))


def session_name(answer: dict) -> str:
    """The name the runner chose (`JP-116(c) - Build`, JP-173), else the keyless form `<graph> - <Step> (r<run>)`."""
    if answer.get("session_name"):
        return str(answer["session_name"])
    who = answer.get("ticket") or answer.get("graph") or "run"
    return "{} - {} (r{})".format(who, step_title(answer["step"]), str(answer["run"])[2:6])


def letter(n: int) -> str:
    """The n-th session's letter, counting from 1: a to z, then aa, ab and so on (JP-173)."""
    if n < 1:
        raise ValueError("letters count from 1")
    out = ""
    while n:
        n, rest = divmod(n - 1, 26)
        out = chr(ord("a") + rest) + out
    return out


def ticket_session_name(ticket: str, n: int, step: str) -> str:
    return "{}({}) - {}".format(ticket, letter(n), step_title(step))


def ticket_group(status: Optional[str]) -> Optional[str]:
    """`josh-360/tickets/<status>`, with `/` in the status as `-` so it is never a nested group; None for no status."""
    if not status:
        return None
    return "{}/{}".format(config().get("ticket_group_root", "josh-360/tickets"), str(status).replace("/", "-").strip())


def _directory(answer: dict) -> str:
    tree = (answer.get("inputs") or {}).get("worktree")
    return tree if isinstance(tree, str) and os.path.isdir(tree) else answer["work_dir"]


def _value(value: object) -> str:
    return value if isinstance(value, str) else json.dumps(value)


def output_lines(answer: dict) -> List[str]:
    """Name each output the step declares (JP-184). The walker refuses a result with any other key under "outputs",
    so a session that is not told the names puts a contract's own fields there instead."""
    if "outputs" not in answer:  # a walker from before JP-184 does not say
        return []
    outputs = answer.get("outputs") or {}
    if not outputs:
        return ['This step declares no outputs: leave "outputs" empty.']
    lines = ['Outputs: put only these keys under "outputs", each one your outcome produces; the walker refuses any '
             "other key, so never put a contract's own fields there directly:"]
    for name, spec in outputs.items():
        spec = spec if isinstance(spec, dict) else {}
        line = "- {} ({})".format(name, spec.get("type", "string"))
        if spec.get("description"):
            line += ": {}".format(str(spec["description"]).rstrip("."))
        if spec.get("contract_file"):
            line += ". Format: {}".format(spec["contract_file"])
        lines.append(line + ".")
    return lines


def result_skeleton(answer: dict) -> str:
    if "outputs" not in answer:
        return '{"outcome": "<one of them>", "outputs": {...}}'
    keys = ", ".join('"{}": ...'.format(name) for name in (answer.get("outputs") or {}))
    return '{{"outcome": "<one of them>", "outputs": {{{}}}}}'.format(keys)


def build_prompt(answer: dict, marker: str, comments: str) -> str:
    """The marker line first, then the rename line, then the task, then (last) the comments, unchanged."""
    name = session_name(answer)
    head = [marker, 'Do not run agent-manager rename; this session\'s name "{}" is final.'.format(name)]
    reads = "Read {}/instructions.md first.".format(answer["role_folder"])
    if answer.get("agent_folder"):
        reads = "Read {0}/instructions.md first, then {1}/instructions.md.".format(answer["role_folder"], answer["agent_folder"])
    body = [reads, answer.get("brief") or "", "Inputs:"]
    body += ["{}: {}".format(k, _value(v)) for k, v in (answer.get("inputs") or {}).items()]
    if answer.get("so_far"):
        body += ["So far:"] + ["{}: {}".format(k, _value(v)) for k, v in answer["so_far"].items()]
    body += ["End with one of these outcomes: {}.".format(", ".join(answer["outcomes"]))] + output_lines(answer)
    body += ["When you are done, use the Write tool to write {} to {}, then stop.".format(result_skeleton(answer),
                                                                                        answer["result_file"]),
             FOLLOW_UPS, "Work folder: {}".format(answer["work_dir"]), FIXED]
    text = "\n".join(head + body)
    if len(text.encode("utf-8")) > int(config().get("prompt_max_bytes", 60000)):
        folder = Path(answer["work_dir"]).parent / "prompts"
        folder.mkdir(parents=True, exist_ok=True)
        file = folder / "{}-{}.md".format(answer["step"], answer["attempt"])
        file.write_text("\n".join(body) + "\n", encoding="utf-8")
        text = "\n".join(head + ["Read {} in full before anything else; it is your task.".format(file)])
    return text + (comments or "")


def _am() -> str:
    found = _find("agent-manager", "JOSH360_AM_BIN")
    if not found:
        raise SpawnRefused("no-cli", "the agent-manager command is not installed or not on the PATH")
    return found


def _groups_file() -> Path:
    home = os.environ.get("JOSH360_HOME") or os.path.join(os.path.expanduser("~"), ".josh-360")
    return Path(home) / "state" / "runner" / "groups-ready.json"


def _ready_groups() -> List[str]:
    try:
        doc = json.loads(_groups_file().read_text(encoding="utf-8"))
        return [g for g in doc if isinstance(g, str)] if isinstance(doc, list) else []
    except (OSError, ValueError):
        return []


def _forget_group(group: str) -> None:
    kept = [g for g in _ready_groups() if g != group]
    try:
        _groups_file().write_text(json.dumps(kept), encoding="utf-8")
    except OSError:
        pass


def _ensure_group(am: str, group: str) -> None:
    """Create the group and each group above it once; remember the ones made, so later spawns skip the calls."""
    ready = _ready_groups()
    if group in ready:
        return
    parts = group.split("/")
    for i in range(1, len(parts) + 1):
        code, out, err = _run([am, "create-group", "/".join(parts[:i])])
        if code != 0 and "already exists" not in (out + err).lower():
            raise SpawnRefused("group", (err.strip() or out.strip()))
    target = _groups_file()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(sorted(set(ready + [group]))), encoding="utf-8")


def ensure_group(group: str) -> bool:
    """Whether the group exists now (made if it was missing). Never raises."""
    try:
        _ensure_group(_am(), group)
        return True
    except (SpawnRefused, subprocess.SubprocessError, OSError):
        return False


def start(answer: dict, marker: str, comments: str) -> dict:
    """Start the session. Returns the handle; raises SpawnRefused(reason)."""
    cfg = config()
    am = _am()
    try:
        group = cfg["group"]
        wanted = answer.get("am_group")
        if wanted:
            try:
                _ensure_group(am, wanted)
                group = wanted
            except SpawnRefused:                       # a status group that cannot be made: the old group, not no session
                pass
        _ensure_group(am, group)
        name, directory = session_name(answer), _directory(answer)
        prompt = build_prompt(answer, marker, comments)
        if not os.path.isdir(directory):
            raise SpawnRefused("no-folder", "the folder {} does not exist".format(directory))
        tried: List[SpawnRefused] = []
        for entry in answer["models"]:
            model = cfg.get("models", {}).get(entry["model"], entry["model"])
            argv = [am, "spawn", "--name", name, "--tool", cfg.get("tool", "claude"), "--group", group,
                    "--directory", directory, "--model", model, "--effort", entry["effort"], "--prompt", prompt, "--json"]
            code, out, err = _run(argv)
            if code == 0:
                return dict(_handle(cfg, out, name, model, entry["effort"], directory), group=group)
            refused = SpawnRefused(classify(out + "\n" + err), err.strip() or out.strip())
            if refused.code not in FALLBACK_ON:
                raise refused
            tried.append(refused)                      # this entry's model cannot take it now: try the tier's next one
        # Every entry was refused for its model, effort or a rate limit. One that may clear (a rate limit) wins, so
        # the step is tried again; otherwise the first entry's refusal, which needs a fix.
        hopeful = [t for t in tried if t.code == "rate-limited"]
        raise (hopeful or tried or [SpawnRefused("refused", "the tier names no model")])[0]
    except subprocess.TimeoutExpired:
        raise SpawnRefused("timeout", "agent-manager did not answer within {} seconds".format(TIMEOUT))
    except OSError as err:
        raise SpawnRefused("no-cli", "agent-manager could not be run: {}".format(type(err).__name__))


def _handle(cfg: dict, out: str, name: str, model: str, effort: str, directory: str) -> dict:
    try:
        reply = json.loads(out)
    except ValueError:
        raise SpawnRefused("no-id", "the spawn reply was not JSON")
    found = None
    for field in cfg.get("id_fields", ["id"]):
        if isinstance(reply, dict) and isinstance(reply.get(field), str) and reply[field]:
            found = reply[field]
            break
    if not found:
        raise SpawnRefused("no-id", "the spawn reply named no session id")
    return {"am_session": found, "name": name, "model": model, "effort": effort, "directory": directory}


def _db_path() -> str:
    return os.environ.get("JOSH360_AM_DB") or os.path.join(
        os.path.expanduser("~"), "Library", "Application Support", "agent-manager", "state.db")


def state(handle: dict) -> str:
    """working, resting, gone or unknown. Unknown changes nothing: a missing file, column or word is never `gone`."""
    session = (handle or {}).get("am_session")
    if not session:
        return "unknown"
    try:
        conn = sqlite3.connect("file:{}?mode=ro".format(_db_path()), uri=True, timeout=10)
        try:
            columns = {row[1] for row in conn.execute("PRAGMA table_info(sessions)")}
            if not {"id", "status", "archived"} <= columns:
                return "unknown"
            row = conn.execute("SELECT status, archived FROM sessions WHERE id = ?", (session,)).fetchone()
        finally:
            conn.close()
    except (sqlite3.Error, OSError):
        return "unknown"
    if row is None or row[1]:
        return "gone"
    words = config().get("status", {})
    for answer in ("working", "resting", "gone"):
        if row[0] in words.get(answer, []):
            return answer
    return "unknown"


def close(handle: dict) -> bool:
    """File the session away (archive it). Never raises."""
    try:
        code, _, _ = _run([_am()] + list(config().get("archive", ["archive"])) + [handle["am_session"]], timeout=60)
        return code == 0
    except (SpawnRefused, subprocess.SubprocessError, OSError, KeyError, ValueError):
        return False


def kill(handle: dict) -> bool:
    """Stop the session's agent and keep its row, so it can be revived (JP-191): `agent-manager kill <id> --json`.
    Never raises."""
    session = (handle or {}).get("am_session")
    if not session:
        return False
    try:
        code, _, _ = _run([_am()] + list(config().get("kill", ["kill"])) + [session, "--json"], timeout=60)
        return code == 0
    except (SpawnRefused, subprocess.SubprocessError, OSError, ValueError):
        return False


def completed_group() -> str:
    """Where a finished step's session is filed until it is archived (JP-191)."""
    return str(config().get("completed_group", "josh-360/completed-steps"))


def move(handle: dict, group: str) -> bool:
    """File the session under the group (made first if missing): `agent-manager move <id> <group>`. Never raises."""
    session = (handle or {}).get("am_session")
    if not session or not ensure_group(group):
        return False
    try:
        code, _, _ = _run([_am(), "move", session, group, "--json"], timeout=60)
    except (SpawnRefused, subprocess.SubprocessError, OSError):
        return False
    if code != 0:
        _forget_group(group)                           # the group may have been deleted by hand: make it again next time
    return code == 0


def placed(handle: dict) -> Optional[Tuple[Optional[str], bool]]:
    """(group, archived) for the session from Agent Manager's database, or None when it cannot be read."""
    session = (handle or {}).get("am_session")
    if not session:
        return None
    try:
        conn = sqlite3.connect("file:{}?mode=ro".format(_db_path()), uri=True, timeout=10)
        try:
            columns = {row[1] for row in conn.execute("PRAGMA table_info(sessions)")}
            if not {"id", "group_name", "archived"} <= columns:
                return None
            row = conn.execute("SELECT group_name, archived FROM sessions WHERE id = ?", (session,)).fetchone()
        finally:
            conn.close()
    except (sqlite3.Error, OSError):
        return None
    return None if row is None else (row[0], bool(row[1]))


# -- telling a lead (JP-175) ----------------------------------------------------------------------------------------
# A plain `agent-manager send` from a script: no session is spawned and no model is called. The text is fixed wording
# with keys, step names and outcomes only (graphs/runner/runner_lib/leads.py), never a step's own words.

def running(session_id: str) -> bool:
    """True only when Agent Manager shows the session working or at rest. Gone or unknown is not running."""
    return state({"am_session": session_id}) in ("working", "resting")


def send(session_id: str, text: str) -> bool:
    """Send one message to a running session. True when agent-manager accepted it."""
    try:
        code, _, _ = _run([_am(), "send", session_id, text, "--json"], timeout=60)
        return code == 0
    except (SpawnRefused, subprocess.SubprocessError, OSError):
        return False


def _sprint_script() -> str:
    return os.environ.get("JOSH360_SPRINT_PY") or os.path.join(
        os.path.expanduser("~"), ".claude", "skills", "sprint", "scripts", "sprint.py")


def handoff(sprint: str, key: str, note: str) -> bool:
    """Hand a new ticket to a sprint's lead with the sprint skill's own `sprint.py handoff`. True on exit 0."""
    script = _sprint_script()
    if not os.path.isfile(script):
        return False
    python = os.environ.get("JOSH360_SPRINT_PYTHON") or "python3"
    try:
        code, _, _ = _run([python, "-I", script, "handoff", key, "--sprint", sprint, "--note", note, "--json"],
                          timeout=60)
        return code == 0
    except (subprocess.SubprocessError, OSError):
        return False
