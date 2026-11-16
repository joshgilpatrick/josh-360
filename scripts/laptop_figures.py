"""Starting figures for JP-96, computed on Josh's laptop by laptop_inventory.py.

Reads Claude Code transcripts (~/.claude/projects/*/*.jsonl) and local git repositories, and returns
counts only. No message text, branch name or file content ever leaves these functions: every value
returned is a number, a date, a fixed label, a skill or agent name, or a repository path.

Definitions (also written out in docs/inventory/starting-figures.md):
  session         one top-level transcript file, projects/<project>/<id>.jsonl. Subagent transcripts
                  (projects/<project>/<id>/subagents/*.jsonl) are not sessions.
  session date    the first timestamp in the file, in the laptop's local time zone.
  Josh's message  a "user" entry typed by a person: not meta, not a sidechain, not a tool result, and
                  not text Claude Code injects (slash-command echoes, hook output, reminders, notices).
  tied to ticket  a ticket key (default JP, AD, CI, GIL) in the session's git branch, or in one of
                  Josh's messages.
"""
from __future__ import annotations

import json
import os
import re
import statistics
import subprocess
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path

# Text Claude Code itself puts in "user" entries. A message starting with one of these is not Josh's.
INJECTED_PREFIXES = (
    "<command-name>", "<command-message>", "<command-args>", "<local-command-stdout>",
    "<local-command-stderr>", "<local-command-caveat>", "<system-reminder>", "<task-notification>",
    "<bash-input>", "<bash-stdout>", "<bash-stderr>", "<user-memory-input>",
    "Caveat: The messages below", "[Request interrupted", "This session is being continued",
)
SLASH_COMMAND = re.compile(r"<command-name>/?([A-Za-z0-9_.:-]+)</command-name>")


def ticket_pattern(keys: list[str]) -> re.Pattern[str]:
    alternatives = "|".join(re.escape(k) for k in keys)
    return re.compile(rf"\b(?:{alternatives})-\d+\b")


def _text_of(content) -> str | None:
    """The typed text of a user entry, or None when it is a tool result or has no text."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        if any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content):
            return None
        parts = [b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"]
        return "\n".join(parts) if parts else None
    return None


def is_josh_message(entry: dict) -> bool:
    if entry.get("type") != "user" or entry.get("isMeta") or entry.get("isSidechain"):
        return False
    if "toolUseResult" in entry or entry.get("isCompactSummary"):
        return False
    text = _text_of((entry.get("message") or {}).get("content"))
    if text is None or not text.strip():
        return False
    return not text.lstrip().startswith(INJECTED_PREFIXES)


def _parse_ts(value) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone()
    except ValueError:
        return None


def read_session(path: Path, tickets: re.Pattern[str]) -> dict:
    """Counts for one transcript. Lines that are not JSON are counted and skipped."""
    first = None
    josh = 0
    bad_lines = 0
    entrypoints: Counter[str] = Counter()
    branch_ticket = False
    message_ticket = False
    skills: Counter[str] = Counter()
    agents: Counter[str] = Counter()
    with path.open("r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                bad_lines += 1
                continue
            if not isinstance(entry, dict):
                continue
            ts = _parse_ts(entry.get("timestamp"))
            if ts and first is None:
                first = ts
            if isinstance(entry.get("entrypoint"), str):
                entrypoints[entry["entrypoint"]] += 1
            branch = entry.get("gitBranch")
            if isinstance(branch, str) and tickets.search(branch):
                branch_ticket = True
            _count_tool_uses(entry, skills, agents)
            if is_josh_message(entry):
                josh += 1
                text = _text_of(entry["message"]["content"]) or ""
                if tickets.search(text):
                    message_ticket = True
            elif entry.get("type") == "user":
                text = _text_of((entry.get("message") or {}).get("content")) or ""
                for name in SLASH_COMMAND.findall(text):
                    skills[name] += 1
    return {
        "first": first,
        "josh_messages": josh,
        "bad_lines": bad_lines,
        "entrypoint": entrypoints.most_common(1)[0][0] if entrypoints else "unknown",
        "ticket_by_branch": branch_ticket,
        "ticket_by_message": message_ticket,
        "skills": skills,
        "agents": agents,
    }


def _count_tool_uses(entry: dict, skills: Counter, agents: Counter) -> None:
    if entry.get("type") != "assistant":
        return
    content = (entry.get("message") or {}).get("content")
    if not isinstance(content, list):
        return
    for block in content:
        if not isinstance(block, dict) or block.get("type") != "tool_use":
            continue
        args = block.get("input") or {}
        if block.get("name") == "Skill" and isinstance(args.get("skill"), str):
            skills[args["skill"]] += 1
        elif block.get("name") in ("Task", "Agent") and isinstance(args.get("subagent_type"), str):
            agents[args["subagent_type"]] += 1


def week_start(d: date) -> date:
    return d - timedelta(days=d.weekday())  # Monday


def _summary(values: list[int]) -> dict:
    if not values:
        return {"sessions": 0, "mean": None, "median": None, "p90": None, "max": None}
    ordered = sorted(values)
    p90 = ordered[min(len(ordered) - 1, int(round(0.9 * (len(ordered) - 1))))]
    return {"sessions": len(values), "mean": round(statistics.mean(values), 2),
            "median": statistics.median(values), "p90": p90, "max": ordered[-1]}


def session_figures(projects: Path, since: date, until: date, keys: list[str], usage_since: date) -> dict:
    """Sessions per week, Josh's messages per session, ticket share, and skill/agent use."""
    tickets = ticket_pattern(keys)
    earliest = min(since, usage_since)
    cutoff = datetime.combine(earliest, datetime.min.time()).timestamp()
    per_week: Counter[str] = Counter()
    msgs_all: list[int] = []
    msgs_by_entry: dict[str, list[int]] = defaultdict(list)
    tied = {"by_branch": 0, "by_branch_or_message": 0}
    skill_use: dict[str, dict] = {}
    agent_use: dict[str, dict] = {}
    files_read = bad_lines = 0
    if not projects.is_dir():
        return {"available": False}
    for path in sorted(projects.glob("*/*.jsonl")):
        try:
            if path.is_symlink() or path.stat().st_mtime < cutoff:
                continue
            s = read_session(path, tickets)
        except OSError:
            continue
        files_read += 1
        bad_lines += s["bad_lines"]
        if s["first"] is None:
            continue
        day = s["first"].date()
        if day >= usage_since:
            _merge_use(skill_use, s["skills"], day)
            _merge_use(agent_use, s["agents"], day)
        if not (since <= day <= until):
            continue
        per_week[week_start(day).isoformat()] += 1
        msgs_all.append(s["josh_messages"])
        msgs_by_entry[s["entrypoint"]].append(s["josh_messages"])
        if s["ticket_by_branch"]:
            tied["by_branch"] += 1
        if s["ticket_by_branch"] or s["ticket_by_message"]:
            tied["by_branch_or_message"] += 1
    for path in projects.glob("*/*/subagents/*.jsonl"):
        try:
            if path.is_symlink() or path.stat().st_mtime < usage_since_ts(usage_since):
                continue
            s = read_session(path, tickets)
        except OSError:
            continue
        if s["first"] and s["first"].date() >= usage_since:
            _merge_use(skill_use, s["skills"], s["first"].date())
            _merge_use(agent_use, s["agents"], s["first"].date())
    weeks = []
    w = week_start(since)
    while w <= until:
        weeks.append({"week_of": w.isoformat(), "sessions": per_week.get(w.isoformat(), 0)})
        w += timedelta(days=7)
    total = len(msgs_all)
    return {
        "available": True,
        "date_range": {"from": since.isoformat(), "to": until.isoformat()},
        "transcripts_read": files_read,
        "unreadable_lines": bad_lines,
        "sessions": total,
        "sessions_per_week": weeks,
        "mean_sessions_per_week": round(total / len(weeks), 2) if weeks else None,
        "josh_messages_per_session": _summary(msgs_all),
        "josh_messages_by_entrypoint": {k: _summary(v) for k, v in sorted(msgs_by_entry.items())},
        "sessions_with_no_josh_message": sum(1 for v in msgs_all if v == 0),
        "tied_to_ticket": {
            "ticket_keys": keys,
            "by_branch": tied["by_branch"],
            "by_branch_or_message": tied["by_branch_or_message"],
            "share_by_branch_or_message": round(tied["by_branch_or_message"] / total, 3) if total else None,
        },
        "usage_since": usage_since.isoformat(),
        "skill_use": dict(sorted(skill_use.items())),
        "agent_use": dict(sorted(agent_use.items())),
    }


def usage_since_ts(d: date) -> float:
    return datetime.combine(d, datetime.min.time()).timestamp()


def _merge_use(table: dict, counts: Counter, day: date) -> None:
    for name, n in counts.items():
        row = table.setdefault(name, {"uses": 0, "last_used": day.isoformat()})
        row["uses"] += n
        row["last_used"] = max(row["last_used"], day.isoformat())


# ---------- loose ends (the local half; open PRs and ticket states are counted in the cloud) ----------

GIT_ENV = dict(os.environ, GIT_OPTIONAL_LOCKS="0", GIT_TERMINAL_PROMPT="0", LC_ALL="C")
SKIP_DIRS = {"node_modules", ".venv", "venv", "worktrees", "Library", ".Trash", "__pycache__"}


def find_repos(roots: list[Path], max_depth: int = 4) -> list[Path]:
    found: list[Path] = []
    for root in roots:
        if not root.is_dir():
            continue
        stack = [(root, 0)]
        while stack:
            folder, depth = stack.pop()
            if (folder / ".git").is_dir():
                found.append(folder)
                continue  # a repo's own subfolders are not searched for more repos
            if depth >= max_depth:
                continue
            try:
                children = [c for c in folder.iterdir()
                            if c.is_dir() and not c.is_symlink() and c.name not in SKIP_DIRS]
            except OSError:
                continue
            stack.extend((c, depth + 1) for c in children)
    return sorted(found)


def _git(repo: Path, *args: str) -> list[str] | None:
    """Runs one read-only git command. Only the commands in READ_ONLY_GIT may be used."""
    if args[0] not in READ_ONLY_GIT:
        raise ValueError(f"not a read-only git command: {args[0]}")
    try:
        out = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True,
                             env=GIT_ENV, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return out.stdout.splitlines() if out.returncode == 0 else None


READ_ONLY_GIT = ("for-each-ref", "worktree", "symbolic-ref", "rev-list")


def repo_loose_ends(repo: Path) -> dict:
    refs = _git(repo, "for-each-ref", "--format=%(refname:short)\t%(upstream)\t%(upstream:track)",
                "refs/heads")
    worktrees = _git(repo, "worktree", "list", "--porcelain")
    head = _git(repo, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD")
    if refs is None:
        return {"readable": False}
    default = (head[0].split("/", 1)[1] if head else None)
    defaults = {default} if default else {"main", "master"}
    no_upstream = ahead = gone = 0
    for line in refs:
        name, upstream, track = (line.split("\t") + ["", ""])[:3]
        if name in defaults:
            if "ahead" in track:
                ahead += 1
            continue
        if not upstream:
            no_upstream += 1
        elif "gone" in track:
            gone += 1
        elif "ahead" in track:
            ahead += 1
    extra_worktrees = max(0, sum(1 for l in (worktrees or []) if l.startswith("worktree ")) - 1)
    stashes = _git(repo, "rev-list", "--walk-reflogs", "--count", "refs/stash")
    return {
        "readable": True,
        "branches": len(refs),
        "branches_without_remote": no_upstream,
        "branches_ahead_of_remote": ahead,
        "branches_whose_remote_is_gone": gone,
        "extra_worktrees": extra_worktrees,
        "stashes": int(stashes[0]) if stashes and stashes[0].isdigit() else 0,
    }


LOOSE_END_KINDS = ("branches_without_remote", "branches_ahead_of_remote",
                   "branches_whose_remote_is_gone", "extra_worktrees")


def loose_end_figures(roots: list[Path], home: Path) -> dict:
    repos = []
    totals: Counter[str] = Counter()
    for repo in find_repos(roots):
        row = repo_loose_ends(repo)
        row["path"] = "~/" + str(repo.relative_to(home)) if _under(repo, home) else str(repo)
        repos.append(row)
        for k in LOOSE_END_KINDS + ("stashes",):
            totals[k] += row.get(k, 0)
    return {
        "roots": ["~/" + str(r.relative_to(home)) if _under(r, home) else str(r) for r in roots],
        "repos_found": len(repos),
        "totals": dict(totals),
        "local_loose_ends": sum(totals[k] for k in LOOSE_END_KINDS),
        "repos": repos,
    }


def _under(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False
