#!/usr/bin/env python3
"""The one read-only laptop step for JP-96: list what runs and what is stored on Josh's work laptop.

Run it once, on the laptop, in the JP-105 hookup sitting:

    python3 scripts/laptop_inventory.py --out ~/josh-360-inventory.json

What it does:
  * Lists launchd jobs, Claude Code hooks, plugins, MCP server names, skills, agent definitions, data
    stores (size, file count, newest change), listening ports and running program names.
  * Computes the starting figures (laptop_figures.py): sessions per week, Josh's messages per session,
    the share of sessions tied to a ticket, local loose ends, and skill and agent use.

What it never does:
  * Write anything except the one output file, which it refuses to overwrite. It sets
    sys.dont_write_bytecode before importing laptop_figures, so not even a __pycache__ folder appears.
  * Put file contents in the output. Every value is a name, a path, a size, a count, a date or a fixed
    label, and check_output() refuses to write anything else.
  * Run any command outside READ_ONLY_COMMANDS, or reach the network.

Works with the macOS system Python (3.9) and the standard library only.
"""
from __future__ import annotations

import argparse
import json
import os
import plistlib
import re
import shlex
import shutil
import subprocess
import sys
import time
from collections import Counter
from datetime import date, datetime, timedelta
from pathlib import Path

sys.dont_write_bytecode = True  # importing the sibling module must not write scripts/__pycache__/
sys.path.insert(0, str(Path(__file__).resolve().parent))
import laptop_figures  # noqa: E402

SCHEMA = "josh-360/laptop-inventory/1"

# Every external command this script may run. Each one only reads.
READ_ONLY_COMMANDS = {
    "launchctl": ["launchctl", "list"],
    "brew": ["brew", "services", "list"],
    "lsof": ["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-F", "cn"],
    "ps": ["ps", "-axo", "comm="],
    "crontab": ["crontab", "-l"],
}
# Extra environment per command: stop Homebrew updating itself or sending analytics during a read.
COMMAND_ENV = {"brew": {"HOMEBREW_NO_AUTO_UPDATE": "1", "HOMEBREW_NO_ANALYTICS": "1",
                        "HOMEBREW_NO_INSTALL_CLEANUP": "1"}}

# Data stores named in the four repositories (JP-96 inventory). Paths are relative to the home folder.
# A glob (*) is expanded; anything missing is reported as missing, which is itself a finding.
KNOWN_STORES = [
    # Claude Code and the harness (~/.claude)
    ".claude/projects", ".claude/jobs", ".claude/plugins", ".claude/plugins/cache", ".claude/file-history",
    ".claude/history.jsonl", ".claude/session-state", ".claude/session-focus", ".claude/sprint-state",
    ".claude/agent-memory", ".claude/.agents/memory", ".claude/.planning", ".claude/deliverables",
    ".claude/daemon", ".claude/context-mode", ".claude/tmp/pr-agent-review",
    # Session Atlas and the cost ledger (claude-360)
    ".claude/atlas", ".claude/cost-ledger", ".claude/artifact-output",
    # Other memory and transcript readers
    ".claude-mem", ".obsidian-wiki", "Development/active/obsidian-wiki/raw/claude-sessions",
    # action-triage, the desk, Agent Command Center and Agent Manager
    "Library/Application Support/action-agent", "Library/Application Support/action-triage",
    "Library/Application Support/Action Triage", "Library/Application Support/agent-services-desk",
    "Library/Application Support/agent-manager", "Library/Logs/action-triage", ".local/share/agent-services-desk",
    "Development/active/josh_projects/agent_command_center/server/data/meetings",
    # Other tools
    "Library/Application Support/com.jgilpatrick.claude-transcript-scrubber", ".config/free-claude-code",
    ".config/opencode", ".local/share/opencode", ".pi/agent/sessions", ".omnara", ".config/twg",
    "Library/CloudStorage/OneDrive-EventusWholeHealth/Development/active/claude_services/skills/task-manager",
]
# Folders whose direct children are each listed with size and count.
SWEEP_DIRS = [".claude", ".claude/atlas", ".claude/cost-ledger", "Library/Application Support/action-agent"]
# Other top-level home folders worth a size: matched by name, case-insensitive.
HOME_NAME_HINTS = re.compile(r"claude|atlas|context|mem|agent|opencode|omnara|obsidian|wiki|vault",
                             re.IGNORECASE)
WALK_FILE_CAP = 300_000

SAFE_TEXT = re.compile(r"^[A-Za-z0-9 _./~@+:,()\[\]#=*%&'-]{0,300}$")


# ---------- output guard ----------

def check_output(value, where: str = "$") -> list[str]:
    """Every leaf must be a number, bool, None or a short single-line string of name/path characters."""
    problems = []
    if isinstance(value, dict):
        for k, v in value.items():
            if not isinstance(k, str) or not SAFE_TEXT.match(k):
                problems.append(f"{where}: unsafe key")
            problems += check_output(v, f"{where}.{k}")
    elif isinstance(value, list):
        for i, v in enumerate(value):
            problems += check_output(v, f"{where}[{i}]")
    elif isinstance(value, str):
        if not SAFE_TEXT.match(value):
            problems.append(f"{where}: value is not a name, path, date or label")
    elif not (value is None or isinstance(value, (bool, int, float))):
        problems.append(f"{where}: unexpected type {type(value).__name__}")
    return problems


def scrub(value):
    """Replaces any string or key the guard would refuse (odd characters, line breaks, long text) with a
    fixed label, so one strange file name cannot stop the run. check_output() still runs afterwards."""
    if isinstance(value, dict):
        out = {}
        for i, (k, v) in enumerate(value.items()):
            key = k if isinstance(k, str) and SAFE_TEXT.match(k) else f"(unlisted {i})"
            out[key] = scrub(v)
        return out
    if isinstance(value, list):
        return [scrub(v) for v in value]
    if isinstance(value, str) and not SAFE_TEXT.match(value):
        return "(unlisted)"
    return value


def tilde(path: Path, home: Path) -> str:
    """~/-relative when the path is under home, as written or with symlinks resolved (on macOS /var is a
    link to /private/var, so a path written through the link would otherwise print in full)."""
    return laptop_figures.tilde(path, home)


def day_of(ts: float | None) -> str | None:
    return datetime.fromtimestamp(ts).date().isoformat() if ts else None


# ---------- commands ----------

def run_read_only(name: str) -> list[str] | None:
    """None when the command is missing or fails; the caller records that it was unavailable."""
    argv = READ_ONLY_COMMANDS[name]
    if shutil.which(argv[0]) is None:
        return None
    try:
        out = subprocess.run(argv, capture_output=True, text=True, errors="replace", timeout=60,
                             stdin=subprocess.DEVNULL, env=dict(os.environ, **COMMAND_ENV.get(name, {})))
    except (OSError, subprocess.TimeoutExpired):
        return None
    return out.stdout.splitlines() if out.returncode == 0 else None


def launchctl_jobs() -> dict:
    lines = run_read_only("launchctl")
    if lines is None:
        return {"available": False}
    jobs = {}
    for line in lines[1:]:
        parts = line.split("\t")
        if len(parts) == 3 and not parts[2].startswith("com.apple."):
            pid, status, label = parts
            jobs[label] = {"running": pid.strip() != "-", "last_exit": status.strip()}
    return {"available": True, "jobs": jobs}


def brew_services() -> dict:
    lines = run_read_only("brew")
    if lines is None:
        return {"available": False}
    rows = [l.split() for l in lines[1:] if l.strip()]
    return {"available": True, "services": {r[0]: (r[1] if len(r) > 1 else "unknown") for r in rows}}


def listening_ports() -> dict:
    lines = run_read_only("lsof")
    if lines is None:
        return {"available": False}
    ports: dict[str, set] = {}
    command = None
    for line in lines:
        if line.startswith("c"):
            command = line[1:]
        elif line.startswith("n") and command:
            port = line.rsplit(":", 1)[-1]
            if port.isdigit():
                ports.setdefault(Path(command).name, set()).add(int(port))
    return {"available": True, "ports": {k: sorted(v) for k, v in sorted(ports.items())}}


def running_programs() -> dict:
    lines = run_read_only("ps")
    if lines is None:
        return {"available": False}
    return {"available": True,
            "programs": dict(sorted(Counter(Path(l.strip()).name for l in lines if l.strip()).items()))}


def cron_entries() -> dict:
    lines = run_read_only("crontab")
    if lines is None:
        return {"available": False}
    active = [l for l in lines if l.strip() and not l.lstrip().startswith("#")]
    words = []
    for line in active:
        words += _split(line)
    return {"available": True, "entries": len(active), "scripts": sorted(set(_path_words(words)))}


# ---------- files ----------

def walk_stats(path: Path) -> dict:
    """Size, file count and newest change for a file or folder, without reading any file. A folder the
    run may not open (no Full Disk Access, a cloud-storage prompt) is reported, not fatal."""
    try:
        if not path.exists():
            return {"exists": False}
        if path.is_file():
            st = path.stat()
            return {"exists": True, "bytes": st.st_size, "files": 1, "newest_change": day_of(st.st_mtime)}
    except OSError:
        return {"exists": None, "error": "unreadable"}
    total = files = 0
    newest = 0.0
    capped = False
    for root, dirs, names in os.walk(path, followlinks=False):
        for n in names:
            try:
                st = os.lstat(os.path.join(root, n))
            except OSError:
                continue
            total += st.st_size
            files += 1
            newest = max(newest, st.st_mtime)
            if files >= WALK_FILE_CAP:
                capped = True
                break
        if capped:
            break
    return {"exists": True, "bytes": total, "files": files, "newest_change": day_of(newest or None),
            "count_capped": capped}


def launch_agent_plists(home: Path) -> list[dict]:
    rows = []
    folders = [home / "Library/LaunchAgents", Path("/Library/LaunchAgents"), Path("/Library/LaunchDaemons")]
    for folder in folders:
        if not folder.is_dir():
            continue
        try:
            plists = sorted(folder.glob("*.plist"))
        except OSError:
            rows.append({"file": tilde(folder, home), "readable": False})
            continue
        for plist in plists:
            row = {"file": tilde(plist, home)}
            try:
                row["changed"] = day_of(plist.stat().st_mtime)
                with plist.open("rb") as fh:
                    data = plistlib.load(fh)
            except Exception:
                row["readable"] = False
                rows.append(row)
                continue
            if not isinstance(data, dict):
                row["readable"] = False
                rows.append(row)
                continue
            args = data.get("ProgramArguments") or ([data["Program"]] if data.get("Program") else [])
            args = [a for a in args if isinstance(a, str)] if isinstance(args, list) else []
            program = _path_words(args[:1])
            row.update({
                "label": data.get("Label"),
                "program": tilde(Path(program[0]), home) if program else None,
                "scripts": [tilde(Path(w), home) if w.startswith("/") else w for w in _path_words(args[1:])],
                "run_at_load": bool(data.get("RunAtLoad")),
                "keep_alive": bool(data.get("KeepAlive")),
                "start_interval_seconds": data.get("StartInterval"),
                "calendar": _calendar(data.get("StartCalendarInterval")),
                "watch_paths": len(data.get("WatchPaths") or []),
                "disabled": bool(data.get("Disabled")),
            })
            for key in ("StandardOutPath", "StandardErrorPath"):
                if isinstance(data.get(key), str):
                    log = Path(data[key])
                    row[key] = {"path": tilde(log, home), **walk_stats(log)}
            rows.append(row)
    return rows


def _calendar(value) -> list[str] | None:
    if not value:
        return None
    items = value if isinstance(value, list) else [value]
    return [",".join(f"{k}={v}" for k, v in sorted(i.items())) for i in items if isinstance(i, dict)]


SCRIPT_NAME = re.compile(r"^[A-Za-z0-9_.-]+\.(?:sh|py|ts|js|mjs|cjs)$")
PATH_START = ("/", "~/", "$HOME/", "./")


def _split(command: str) -> list[str]:
    try:
        return shlex.split(command or "")
    except ValueError:
        return (command or "").split()


def _path_words(words: list, depth: int = 0) -> list[str]:
    """The whole words that are file paths or script names, and nothing else (arguments may hold tokens,
    names or URLs). A word is kept only if it starts like a path (/, ~/, $HOME/, ./) or is a bare script
    file name, and holds no "=" or "://". A word with spaces in it is kept only when it is a path that
    exists (such as ".../Application Support/..."); otherwise it is split and each part judged alone, so
    a `sh -c "..."` command line never passes through whole."""
    out: list[str] = []
    for w in words:
        if not isinstance(w, str) or not w.strip():
            continue
        w = w.strip()
        if any(c.isspace() for c in w):
            if w.startswith("/") and "=" not in w and "://" not in w and _exists(w):
                out.append(w)
            elif depth < 3:
                out += _path_words(_split(w), depth + 1)
            continue
        if "=" in w or "://" in w:
            continue
        if w.startswith(PATH_START) or SCRIPT_NAME.match(w):
            out.append(w)
    return [w for w in out if SAFE_TEXT.match(w)]


def _exists(path: str) -> bool:
    try:
        return os.path.exists(path)
    except (OSError, ValueError):
        return False


def _command_paths(command, home: Path) -> list[str]:
    words = _path_words(_split(command) if isinstance(command, str) else [])
    return [tilde(Path(w), home) if w.startswith("/") else w for w in words]


def load_json(path: Path):
    try:
        with path.open("r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def claude_settings(home: Path) -> dict:
    result = {}
    for rel in (".claude/settings.json", ".claude/settings.local.json"):
        data = load_json(home / rel)
        if not isinstance(data, dict):
            result[rel] = {"readable": False}
            continue
        hooks = []
        for event, groups in (data.get("hooks") or {}).items():
            for group in groups if isinstance(groups, list) else []:
                for h in (group.get("hooks") or []) if isinstance(group, dict) else []:
                    if isinstance(h, dict):
                        hooks.append({"event": event, "matcher": _safe(group.get("matcher")),
                                      "type": _safe(h.get("type")),
                                      "scripts": _command_paths(h.get("command", ""), home)})
        result[rel] = {
            "readable": True,
            "hooks": hooks,
            "enabled_plugins": sorted(k for k, v in (data.get("enabledPlugins") or {}).items() if v),
            "disabled_plugins": sorted(k for k, v in (data.get("enabledPlugins") or {}).items() if not v),
            "marketplaces": sorted((data.get("extraKnownMarketplaces") or {}).keys()),
            "mcp_servers": sorted((data.get("mcpServers") or {}).keys()),
            "status_line": _command_paths((data.get("statusLine") or {}).get("command", ""), home),
            "api_key_helper": _command_paths(data.get("apiKeyHelper") or "", home),
        }
    user = load_json(home / ".claude.json")
    if isinstance(user, dict):
        projects = user.get("projects") or {}
        result[".claude.json"] = {
            "mcp_servers": sorted((user.get("mcpServers") or {}).keys()),
            "projects_with_mcp_servers": sum(1 for p in projects.values()
                                             if isinstance(p, dict) and p.get("mcpServers")),
        }
    installed = load_json(home / ".claude/plugins/installed_plugins.json")
    if isinstance(installed, dict):
        result["installed_plugins"] = sorted((installed.get("plugins") or installed).keys())
    return result


def _safe(value) -> str | None:
    return value if isinstance(value, str) and SAFE_TEXT.match(value) else (None if value is None else "(unlisted)")


def definitions(home: Path) -> dict:
    """Skill and agent definitions by name, with each one's last change."""
    out = {}
    for rel in (".claude/skills", ".claude/.agents/skills", ".agents/skills"):
        try:
            folder = home / rel
            if folder.is_dir():
                out[rel] = {d.name: day_of(_newest(d)) for d in sorted(folder.iterdir())
                            if d.is_dir() or d.is_symlink()}
        except OSError:
            out[rel] = {"error": "unreadable"}
    for rel in (".claude/agents", ".claude/commands"):
        try:
            folder = home / rel
            if folder.is_dir():
                out[rel] = {f.stem: day_of(_mtime(f)) for f in sorted(folder.rglob("*"))
                            if f.suffix in (".md", ".toml") and f.is_file()}
        except OSError:
            out[rel] = {"error": "unreadable"}
    try:
        plugin_cache = home / ".claude/plugins/cache"
        if plugin_cache.is_dir():
            out["plugin_skills"] = sorted({p.parent.name for p in plugin_cache.glob("*/*/*/skills/*/SKILL.md")})
    except OSError:
        out["plugin_skills"] = ["(unreadable)"]
    return out


def _mtime(path: Path) -> float | None:
    try:
        return path.stat().st_mtime
    except OSError:
        return None


def _newest(path: Path) -> float | None:
    try:
        target = path.resolve()
        times = [t for t in (_mtime(p) for p in target.rglob("*")) if t]
        return max(times) if times else target.stat().st_mtime
    except OSError:
        return None


def _children(folder: Path) -> list[Path]:
    try:
        return sorted(c for c in folder.iterdir() if not c.is_symlink()) if folder.is_dir() else []
    except OSError:
        return []


def stores(home: Path) -> dict:
    known = {tilde(home / rel, home): walk_stats(home / rel) for rel in KNOWN_STORES}
    swept = {tilde(home / rel, home): {c.name: walk_stats(c) for c in _children(home / rel)}
             for rel in SWEEP_DIRS}
    hinted = {tilde(c, home): walk_stats(c) for c in _children(home)
              if HOME_NAME_HINTS.search(c.name) and c.name != ".claude"}
    # Databases only inside the named stores, never across all of Application Support.
    sqlite = {}
    for base in [home / ".claude"] + [home / rel for rel in KNOWN_STORES if rel != ".claude/projects"]:
        for db in _find_sqlite(base):
            sqlite[tilde(db, home)] = walk_stats(db)
    return {"known": known, "children": swept, "home_folders": hinted, "sqlite_files": sqlite}


def _find_sqlite(base: Path, max_depth: int = 4) -> list[Path]:
    """SQLite files up to max_depth below base, skipping transcripts. os.walk skips unreadable folders."""
    found = []
    if not _is_dir(base):
        return found
    base_depth = len(base.parts)
    for root, dirs, names in os.walk(base, followlinks=False):
        if len(Path(root).parts) - base_depth >= max_depth or "projects" in Path(root).parts[-1:]:
            dirs[:] = []
        for n in names:
            if n.endswith((".db", ".sqlite", ".sqlite3")):
                found.append(Path(root) / n)
    return sorted(found)


def _is_dir(path: Path) -> bool:
    try:
        return path.is_dir()
    except OSError:
        return False


# ---------- main ----------

def default_range(today: date) -> tuple[date, date]:
    """The twelve whole weeks (Monday to Sunday) before the current week."""
    this_monday = today - timedelta(days=today.weekday())
    return this_monday - timedelta(weeks=12), this_monday - timedelta(days=1)


def build(home: Path, since: date, until: date, keys: list[str], repo_roots: list[Path],
          usage_days: int, today: date) -> dict:
    started = time.time()
    sections = {
        "launchd_plists": lambda: launch_agent_plists(home),
        "launchctl": launchctl_jobs,
        "brew_services": brew_services,
        "listening_ports": listening_ports,
        "running_programs": running_programs,
        "cron": cron_entries,
        "claude_settings": lambda: claude_settings(home),
        "definitions": lambda: definitions(home),
        "stores": lambda: stores(home),
        "figures": lambda: laptop_figures.session_figures(home / ".claude/projects", since, until, keys,
                                                          today - timedelta(days=usage_days)),
        "loose_ends": lambda: laptop_figures.loose_end_figures(repo_roots, home),
    }
    report = {"schema": SCHEMA, "run_on": today.isoformat(), "home": "~"}
    for name, run in sections.items():
        # One failing section is recorded by its error type only (never its message, which can hold
        # a path or file text) and the rest of the run carries on.
        try:
            report[name] = run()
        except Exception as exc:  # noqa: BLE001
            report[name] = {"error": type(exc).__name__}
    report["seconds"] = round(time.time() - started, 1)
    return report


def main(argv: list[str] | None = None) -> int:
    today = date.today()
    since_default, until_default = default_range(today)
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--out", required=True, help="output JSON file (must not exist yet)")
    p.add_argument("--home", default=str(Path.home()), help="home folder to inventory")
    p.add_argument("--since", type=date.fromisoformat, default=since_default)
    p.add_argument("--until", type=date.fromisoformat, default=until_default)
    p.add_argument("--ticket-keys", default="JP,AD,CI,GIL")
    p.add_argument("--repo-root", action="append", help="folder searched for git repos (repeatable); "
                                                         "default ~/Development and ~/.claude")
    p.add_argument("--usage-days", type=int, default=90, help="window for skill and agent use")
    args = p.parse_args(argv)

    home = Path(args.home).expanduser().resolve()
    out = Path(args.out).expanduser()
    if out.exists():
        print(f"refusing to overwrite {out}", file=sys.stderr)
        return 2
    roots = [Path(r).expanduser() for r in args.repo_root] if args.repo_root else [home / "Development",
                                                                                 home / ".claude"]
    keys = [k.strip() for k in args.ticket_keys.split(",") if k.strip()]
    report = build(home, args.since, args.until, keys, roots, args.usage_days, today)
    report = scrub(report)
    problems = check_output(report)
    if problems:
        print("refusing to write: the output holds something other than names, paths, sizes and counts",
              file=sys.stderr)
        for line in problems[:20]:
            print("  " + line, file=sys.stderr)
        return 3
    with out.open("x", encoding="utf-8") as fh:  # "x": never replaces an existing file
        json.dump(report, fh, indent=1, sort_keys=True)
        fh.write("\n")
    fig = report["figures"]
    print(f"wrote {out}: {len(report['launchd_plists'])} launchd plists, "
          f"{fig.get('sessions', 0)} sessions, {report['loose_ends']['repos_found']} repos, "
          f"{report['seconds']} s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
