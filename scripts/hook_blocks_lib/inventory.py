"""Every hook on the laptop (JP-182), so a hook that never blocked still appears with a count of 0.

Sources, in this order:
  managed    the machine-wide managed settings, when present
  user       ~/.claude/settings.json and settings.local.json (the claude-harness settings)
  extra      settings files sessions get with --settings (action-triage's guardrails), when present
  project    <folder>/.claude/settings.json and settings.local.json for every folder a transcript ran in
  plugin     hooks/hooks.json of every installed plugin not switched off in enabledPlugins
  josh-360   each executable file in the laptop copy's hooks/<Event>/, which the dispatcher entry runs

A settings file can hold credentials: only its "hooks" and "enabledPlugins" keys are ever read.
"""
from __future__ import annotations

import json
import os
import re
import shlex
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

DISPATCH_MARK = "/hooks/dispatch"
# Settings files that sessions are started with through --settings, so no folder's .claude/ holds them.
KNOWN_EXTRA = ["~/Development/active/josh_projects/action-triage/src/orchestrator/b-guardrails.json"]
MANAGED = ["/Library/Application Support/ClaudeCode/managed-settings.json", "/etc/claude-code/managed-settings.json"]
INTERPRETERS = {"node", "python", "python3", "bash", "sh", "zsh", "npx", "tsx", "deno", "bun", "uv", "uvx", "env",
                "exec", "ruby", "perl", "run", "--", "/usr/bin/python3", "/bin/bash", "/bin/sh"}
TOOL_EVENTS = {"PreToolUse", "PostToolUse", "PermissionRequest"}


class Hook(dict):
    """One hook: id, source, source_path, event, matcher, command, script, scope (the folders it runs in, or None for
    every session), via (the dispatcher entry a josh-360 file runs through) and note (set when it never runs)."""


def read_json(path: Path) -> Tuple[Optional[dict], str]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None, ""
    except (OSError, ValueError) as e:
        return None, "{} cannot be read ({})".format(path, e.__class__.__name__)
    return (data, "") if isinstance(data, dict) else (None, "{} is not a JSON object".format(path))


def expand(text: str, plugin_root: Optional[str] = None, project: Optional[str] = None) -> str:
    if project:
        text = text.replace("${CLAUDE_PROJECT_DIR}", project).replace("$CLAUDE_PROJECT_DIR", project)
    if plugin_root:
        text = text.replace("${CLAUDE_PLUGIN_ROOT}", plugin_root).replace("$CLAUDE_PLUGIN_ROOT", plugin_root)
    home = os.path.expanduser("~")
    text = text.replace("${HOME}", home).replace("$HOME", home)
    return os.path.expanduser(text) if text.startswith("~") else text


def script_of(command: str, plugin_root: Optional[str] = None, project: Optional[str] = None) -> Optional[str]:
    """The file a hook command runs: the first word that is a path, skipping interpreters and flags. A path that
    exists wins over one that does not."""
    text = expand(command, plugin_root, project)
    try:
        words = shlex.split(text)
    except ValueError:
        words = text.split()
    paths = [os.path.expanduser(w) for w in words if "/" in w and not w.startswith("-") and w not in INTERPRETERS]
    for p in paths:
        if os.path.isfile(p):
            return p
    return paths[0] if paths else None


def matches(matcher: Optional[str], tool: Optional[str]) -> bool:
    """Claude Code's rule: no matcher, "" or "*" matches every tool; a plain name matches that tool; anything else
    is a regular expression over the tool name."""
    if matcher in (None, "", "*") or tool is None:
        return True
    try:
        return re.fullmatch(matcher, tool) is not None
    except re.error:
        return matcher == tool


def _name(command: str, script: Optional[str]) -> str:
    return os.path.basename(script) if script else re.sub(r"\s+", " ", command).strip()[:48]


def from_settings(data: dict, *, source: str, path: str, scope: Optional[List[str]] = None,
                  plugin_root: Optional[str] = None, label: str = "") -> List[Hook]:
    out: List[Hook] = []
    hooks = data.get("hooks")
    if not isinstance(hooks, dict):
        return out
    for event, groups in hooks.items():
        for group in groups if isinstance(groups, list) else []:
            if not isinstance(group, dict):
                continue
            for h in group.get("hooks") or []:
                if not isinstance(h, dict):
                    continue
                kind = str(h.get("type") or "command")
                command = str(h.get("command") or h.get("prompt") or h.get("url") or "")
                if kind != "command":
                    command = "{} hook: {}".format(kind, re.sub(r"\s+", " ", command)[:80])
                script = script_of(command, plugin_root, scope[0] if scope else None) if kind == "command" else None
                out.append(Hook(id="{}:{}".format(label or source, _name(command, script)), source=source,
                                source_path=path, event=str(event), matcher=group.get("matcher"), command=command,
                                script=script, scope=scope, via=None, note=""))
    return out


def _josh360_files(copy: Path, event: str) -> List[Path]:
    folder = copy / "hooks" / event
    if not folder.is_dir():
        return []
    return sorted(p for p in folder.iterdir() if p.is_file() and os.access(str(p), os.X_OK))


def expand_dispatcher(hooks: List[Hook], copy: Path) -> List[Hook]:
    """A dispatcher entry is replaced by the josh-360 files it runs, and files whose event has no entry are listed
    as not registered (they never run, so they never block)."""
    out: List[Hook] = []
    registered: Dict[str, Hook] = {}
    for h in hooks:
        if DISPATCH_MARK in h["command"] and ".josh-360" in h["command"]:
            registered.setdefault(h["event"], h)
        else:
            out.append(h)
    events = set(registered) | {p.name for p in (copy / "hooks").iterdir() if p.is_dir()} if (copy / "hooks").is_dir() \
        else set(registered)
    for event in sorted(events):
        entry = registered.get(event)
        for f in _josh360_files(copy, event):
            out.append(Hook(id="josh-360:{}/{}".format(event, f.name), source="josh-360", source_path=str(f),
                            event=event, matcher=entry["matcher"] if entry else None, command=str(f), script=str(f),
                            scope=None, via=entry["source_path"] if entry else None,
                            note="" if entry else "no dispatcher entry for {}, so it never runs".format(event)))
    return out


def _plugins(claude_home: Path, enabled: Dict[str, object]) -> Iterable[Tuple[str, str]]:
    """(plugin key, install folder) for every installed plugin not switched off."""
    seen = set()
    data, _ = read_json(claude_home / "plugins" / "installed_plugins.json")
    plugins = (data or {}).get("plugins") if isinstance((data or {}).get("plugins"), dict) else {}
    for key, entries in plugins.items():
        for e in entries if isinstance(entries, list) else [entries]:
            path = e.get("installPath") if isinstance(e, dict) else None
            if path and enabled.get(key) is not False and (key, path) not in seen:
                seen.add((key, path))
                yield key, path
    if not plugins:  # no install list: fall back to what is in the cache
        for hj in sorted((claude_home / "plugins").glob("cache/*/*/*/hooks/hooks.json")):
            root = hj.parent.parent
            key = "{}@{}".format(root.parent.name, root.parent.parent.name)
            if enabled.get(key) is not False:
                yield key, str(root)


def plugin_hooks(claude_home: Path, enabled: Dict[str, object]) -> Tuple[List[Hook], List[str]]:
    out: List[Hook] = []
    problems: List[str] = []
    for key, root in _plugins(claude_home, enabled):
        for candidate in (Path(root) / "hooks" / "hooks.json",):
            data, why = read_json(candidate)
            if why:
                problems.append(why)
            if data:
                out += from_settings(data, source="plugin", path=str(candidate), plugin_root=root,
                                     label="plugin {}".format(key.split("@")[0]))
    return out, problems


def build(*, claude_home: Path, copy: Path, folders: Iterable[str], extra: Iterable[str] = ()) -> Tuple[List[Hook], List[str]]:
    """(hooks, problems). A settings file that cannot be read is a problem, never an empty hook list."""
    hooks: List[Hook] = []
    problems: List[str] = []
    enabled: Dict[str, object] = {}

    def add(path: Path, source: str, scope: Optional[List[str]] = None, label: str = "") -> None:
        data, why = read_json(path)
        if why:
            problems.append(why)
        if data:
            hooks.extend(from_settings(data, source=source, path=str(path), scope=scope, label=label or source))
            if source == "user" and isinstance(data.get("enabledPlugins"), dict):
                enabled.update(data["enabledPlugins"])

    for m in MANAGED:
        add(Path(m), "managed")
    add(claude_home / "settings.json", "user")
    add(claude_home / "settings.local.json", "user")
    for e in list(extra) + KNOWN_EXTRA:
        p = Path(os.path.expanduser(e))
        add(p, "extra", label="extra {}".format(p.stem))
    for folder in sorted(set(f for f in folders if f)):
        for name in ("settings.json", "settings.local.json"):
            p = Path(folder) / ".claude" / name
            if p.resolve() != (claude_home / name).resolve():
                add(p, "project", scope=[folder], label="project {}".format(Path(folder).name))
    found, why = plugin_hooks(claude_home, enabled)
    hooks += found
    problems += why
    hooks = expand_dispatcher(hooks, copy)
    unique: Dict[Tuple, Hook] = {}
    for h in hooks:  # worktrees of one repo carry the same project hooks: list each once, with every folder
        where = os.path.basename(h["source_path"]) if h["source"] == "project" else h["source_path"]
        key = (h["source"], where, h["event"], str(h["matcher"]), h["command"])
        if key in unique and h["scope"]:
            unique[key]["scope"] = sorted(set(unique[key]["scope"]) | set(h["scope"]))
        else:
            unique.setdefault(key, h)
    hooks = list(unique.values())
    taken: Dict[str, int] = {}
    for h in hooks:
        base = h["id"]
        taken[base] = taken.get(base, 0) + 1
        if taken[base] > 1:
            h["id"] = "{} ({})".format(base, h["event"] if taken[base] == 2 else taken[base])
    return hooks, problems


def candidates(hooks: List[Hook], event: str, tool: Optional[str], folder: Optional[str]) -> List[Hook]:
    """The hooks that ran for this event, tool and folder."""
    out = []
    for h in hooks:
        if h["event"] != event or h["note"]:
            continue
        if event in TOOL_EVENTS and not matches(h["matcher"], tool):
            continue
        if h["scope"] and not (folder and any(folder == s or folder.startswith(s.rstrip("/") + "/") for s in h["scope"])):
            continue
        out.append(h)
    return out
