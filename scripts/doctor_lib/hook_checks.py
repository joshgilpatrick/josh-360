"""Hook checks (JP-152): are the Claude Code hooks Josh 360 relies on registered in ~/.claude/settings.json and
present and executable in the laptop's copy. Reads only. Sources: JP-105 (dispatcher), JP-107 (ledger spool),
JP-110 (ticket offer), JP-111 (Atlas removal guard, Jira link), JP-118 (ticket comments)."""
from __future__ import annotations

import datetime
import json
import os
import re
import sys
from typing import Dict, List, Optional, Tuple

sys.dont_write_bytecode = True
from .core import FAIL, PASS, SKIP, WARN, Ctx, Result, check  # noqa: E402

EVENTS = ["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "Stop",
          "SubagentStop", "PreCompact", "PostCompact"]
MARK = ".josh-360/repo/hooks/dispatch"
OLD_ATLAS = re.compile(r"(atlas-hook\.js|atlas-removal-guard\.js|jira-link-hook\.sh)")
ADD_HOOKS_FIX = "python3 ~/.claude/scripts/add-josh-360-hooks.py (or: doctor --fix); it backs up settings.json first"
# The hooks Josh named, by ticket: file -> the event(s) whose dispatcher entry must exist for it to fire.
NAMED = [
    ("ledger-spool", "JP-107", ["SessionStart/20-ledger-spool", "SessionEnd/20-ledger-spool"]),
    ("ticket-offer", "JP-110", ["PreToolUse/30-ticket-offer"]),
    ("ticket-comments", "JP-118", ["PostToolUse/40-ticket-comments", "UserPromptSubmit/40-ticket-comments"]),
    ("atlas-guard", "JP-111", ["PreToolUse/10-atlas-removal-guard", "PostToolUse/40-jira-session-link"]),
    ("graph-step", "JP-117", ["UserPromptSubmit/20-graph-step", "PreToolUse/20-graph-step-guard",
                              "PostToolUse/20-graph-step-reflect", "Stop/20-graph-step-stop"]),
]


def read_settings(ctx: Ctx) -> Tuple[Optional[dict], str]:
    """(settings, "") or (None, why not). The file can hold credentials: only its hooks entries are ever looked at."""
    path = ctx.settings_path
    if not path.is_file():
        return None, "{} does not exist".format(ctx.tilde(path))
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        return None, "{} cannot be read as JSON ({})".format(ctx.tilde(path), e.__class__.__name__)
    return (data, "") if isinstance(data, dict) else (None, "{} is not a JSON object".format(ctx.tilde(path)))


def registered_events(settings: dict) -> Dict[str, str]:
    """event -> the dispatcher command registered for it."""
    found: Dict[str, str] = {}
    hooks = settings.get("hooks")
    if not isinstance(hooks, dict):
        return found
    for event, groups in hooks.items():
        for group in groups if isinstance(groups, list) else []:
            for h in (group.get("hooks") if isinstance(group, dict) else None) or []:
                cmd = str(h.get("command", "")) if isinstance(h, dict) else ""
                if MARK in cmd:
                    found[event] = cmd
    return found


def hook_files(ctx: Ctx) -> Dict[str, List[str]]:
    """event -> hook file names present in the laptop copy's hooks/<Event>/."""
    out: Dict[str, List[str]] = {}
    for event in EVENTS:
        folder = ctx.copy / "hooks" / event
        if folder.is_dir():
            names = sorted(p.name for p in folder.iterdir() if p.is_file() and p.name != "README.md")
            if names:
                out[event] = names
    return out


def _bad_command(cmd: str, event: str) -> bool:
    """The entry must hand its own event name to the dispatcher, or the wrong folder of hooks runs."""
    return not re.search(r'exec\s+"\$f"\s+{}\s*$'.format(re.escape(event)), cmd.strip())


@check("hooks", "settings")
def settings_readable(ctx: Ctx) -> Result:
    settings, why = read_settings(ctx)
    if settings is None:
        return Result("hooks.settings", FAIL, why, ADD_HOOKS_FIX, "hooks" if "does not exist" in why else "")
    return Result("hooks.settings", PASS, "{} is readable".format(ctx.tilde(ctx.settings_path)))


@check("hooks", "dispatch")
def dispatcher_entries(ctx: Ctx) -> List[Result]:
    settings, why = read_settings(ctx)
    if settings is None:
        return [Result("hooks.dispatch", SKIP, why)]
    reg, files = registered_events(settings), hook_files(ctx)
    out: List[Result] = []
    for event in EVENTS:
        needed = event in files
        cid = "hooks.dispatch-" + event
        if event in reg:
            if _bad_command(reg[event], event):
                out.append(Result(cid, FAIL, "the {} entry does not pass {} to the dispatcher".format(event, event),
                                  ADD_HOOKS_FIX + "; remove the odd entry first (add-josh-360-hooks.py --remove)"))
            else:
                out.append(Result(cid, PASS, "{} runs hooks/dispatch{}".format(
                    event, " ({})".format(", ".join(files[event])) if needed else " (no hook files yet)")))
        elif needed:
            out.append(Result(cid, FAIL, "no dispatcher entry for {}, so {} never run".format(event, ", ".join(files[event])),
                              ADD_HOOKS_FIX, "hooks"))
        else:
            out.append(Result(cid, WARN, "no dispatcher entry for {} (no hook files use it yet)".format(event),
                              ADD_HOOKS_FIX, "hooks"))
    return out


@check("hooks", "files")
def hook_files_executable(ctx: Ctx) -> Result:
    bad: List[str] = []
    dispatch = ctx.copy / "hooks" / "dispatch"
    if not (dispatch.is_file() and os.access(str(dispatch), os.X_OK)):
        bad.append("hooks/dispatch")
    for event, names in hook_files(ctx).items():
        for name in names:
            p = ctx.copy / "hooks" / event / name
            if not os.access(str(p), os.X_OK):
                bad.append("hooks/{}/{}".format(event, name))
    if bad:
        return Result("hooks.files", FAIL, "missing or not executable: " + ", ".join(bad),
                      "python3 ~/.josh-360/repo/laptop/follow.py reinstalls the copy; if it persists, report it as a bug")
    return Result("hooks.files", PASS, "hooks/dispatch and every hook file are executable")


@check("hooks", "named")
def named_hooks(ctx: Ctx) -> List[Result]:
    settings, _ = read_settings(ctx)
    reg = registered_events(settings) if settings is not None else {}
    out: List[Result] = []
    for name, ticket, paths in NAMED:
        cid = "hooks." + name
        missing = [p for p in paths if not os.access(str(ctx.copy / "hooks" / p), os.X_OK)]
        unregistered = sorted({p.split("/")[0] for p in paths} - set(reg))
        if missing:
            out.append(Result(cid, FAIL, "{} hook file(s) missing or not executable: {}".format(ticket, ", ".join(missing)),
                              "python3 ~/.josh-360/repo/laptop/follow.py; if the file is not in main, it was never merged"))
        elif unregistered:
            out.append(Result(cid, FAIL, "{} hook is installed but {} has no dispatcher entry".format(
                ticket, "/".join(unregistered)), ADD_HOOKS_FIX, "hooks"))
        else:
            out.append(Result(cid, PASS, "{}: {} present and registered".format(ticket, ", ".join(p.split("/")[0] for p in paths))))
    return out


@check("hooks", "old-atlas")
def old_atlas_hooks(ctx: Ctx) -> Result:
    if not ctx.settings_path.is_file():
        return Result("hooks.old-atlas", SKIP, "no settings file")
    try:
        text = ctx.settings_path.read_text(encoding="utf-8")
    except OSError:
        return Result("hooks.old-atlas", SKIP, "settings file unreadable")
    if OLD_ATLAS.search(text):
        return Result("hooks.old-atlas", FAIL, "settings.json still has hook entries of the old Session Atlas (JP-111)",
                      "it is removed by the retire-session-atlas job once ledger-backfill has succeeded; check backfills.retire-session-atlas")
    return Result("hooks.old-atlas", PASS, "no hook entries of the old Session Atlas remain")


@check("hooks", "log")
def hooks_log(ctx: Ctx) -> Result:
    """Hooks that failed or blocked in the last day, by name and count only."""
    cid = "hooks.log"
    path = ctx.logs / "hooks.log"
    if not path.is_file():
        return Result(cid, PASS, "no hook has failed (no hooks.log yet)")
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()[-500:]
    except OSError:
        return Result(cid, WARN, "{} cannot be read".format(ctx.tilde(path)))
    recent: Dict[str, int] = {}
    for line in lines:
        parts = line.split(" ", 3)
        if len(parts) < 4 or "failed (exit" not in parts[3]:
            continue
        try:
            when = datetime.datetime.strptime(parts[0], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)
        except ValueError:
            continue
        if ctx.now.timestamp() - when.timestamp() <= 86400:
            name = parts[3].split(" ", 1)[0]
            recent[name] = recent.get(name, 0) + 1
    if recent:
        text = ", ".join("{} x{}".format(k, v) for k, v in sorted(recent.items()))
        return Result(cid, WARN, "hooks that failed in the last 24 hours: " + text, "read ~/.josh-360/logs/hooks.log")
    return Result(cid, PASS, "no hook failed in the last 24 hours")
