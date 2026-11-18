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


class SpawnRefused(Exception):
    """A session could not be started. The message is one of: no-cli, group, refused, timeout, no-id."""


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


def session_name(answer: dict) -> str:
    title = " ".join(w.capitalize() for w in str(answer["step"]).split("_"))
    who = answer.get("ticket") or answer.get("graph") or "run"
    return "{} - {} (r{})".format(who, title, str(answer["run"])[2:6])


def _directory(answer: dict) -> str:
    tree = (answer.get("inputs") or {}).get("worktree")
    return tree if isinstance(tree, str) and os.path.isdir(tree) else answer["work_dir"]


def _value(value: object) -> str:
    return value if isinstance(value, str) else json.dumps(value)


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
    body += ["End with one of these outcomes: {}.".format(", ".join(answer["outcomes"])),
             'When you are done, use the Write tool to write {{"outcome": "<one of them>", "outputs": {{...}}}} to {}, '
             "then stop.".format(answer["result_file"]),
             "Work folder: {}".format(answer["work_dir"]), FIXED]
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
        raise SpawnRefused("no-cli")
    return found


def _ensure_group(am: str, group: str) -> None:
    home = os.environ.get("JOSH360_HOME") or os.path.join(os.path.expanduser("~"), ".josh-360")
    marker = Path(home) / "state" / "runner" / "group-ready"
    if marker.exists():
        return
    parts = group.split("/")
    for i in range(1, len(parts) + 1):
        code, out, err = _run([am, "create-group", "/".join(parts[:i])])
        if code != 0 and "already exists" not in (out + err).lower():
            raise SpawnRefused("group")
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text("ok\n", encoding="utf-8")


def start(answer: dict, marker: str, comments: str) -> dict:
    """Start the session. Returns the handle; raises SpawnRefused(reason)."""
    cfg = config()
    am = _am()
    try:
        _ensure_group(am, cfg["group"])
        name, directory = session_name(answer), _directory(answer)
        prompt = build_prompt(answer, marker, comments)
        last = "refused"
        for entry in answer["models"]:
            model = cfg.get("models", {}).get(entry["model"], entry["model"])
            argv = [am, "spawn", "--name", name, "--tool", cfg.get("tool", "claude"), "--group", cfg["group"],
                    "--directory", directory, "--model", model, "--effort", entry["effort"], "--prompt", prompt, "--json"]
            code, out, err = _run(argv)
            text = (out + err).lower()
            if code == 0:
                return _handle(cfg, out, name, model, entry["effort"], directory)
            if "is not installed" in text:
                raise SpawnRefused("no-cli")
            if "model" not in text and "effort" not in text:
                raise SpawnRefused("refused")
        raise SpawnRefused(last)
    except subprocess.TimeoutExpired:
        raise SpawnRefused("timeout")
    except OSError:
        raise SpawnRefused("no-cli")


def _handle(cfg: dict, out: str, name: str, model: str, effort: str, directory: str) -> dict:
    try:
        reply = json.loads(out)
    except ValueError:
        raise SpawnRefused("no-id")
    found = None
    for field in cfg.get("id_fields", ["id"]):
        if isinstance(reply, dict) and isinstance(reply.get(field), str) and reply[field]:
            found = reply[field]
            break
    if not found:
        raise SpawnRefused("no-id")
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
