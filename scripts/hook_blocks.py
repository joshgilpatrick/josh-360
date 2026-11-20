#!/usr/bin/env python3
"""List every time a Claude Code hook blocked something on the laptop (JP-182), from the stored transcripts.

    python3 ~/.josh-360/repo/scripts/hook_blocks.py [--days 14]

Reads ~/.claude/projects (main sessions and subagents), the hook list (~/.claude/settings*.json, project settings of
every folder a transcript ran in, enabled plugins' hooks/hooks.json, settings files passed with --settings such as
action-triage's guardrails, and the laptop copy's hooks/) and ~/.josh-360/logs/hooks.log. Writes one review file,
~/.josh-360/reviews/hook-blocks/hook-blocks-<date>.md, with the same data beside it as .json, and prints its path
and the count per hook. Nothing else is written, and nothing is sent anywhere: the file can hold patient data.

The review-hook-blocks skill (.claude/skills/review-hook-blocks/) runs this and turns the file into a verdict per hook.
Python 3.9, standard library only.
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import sys
from pathlib import Path
from typing import Dict, List, Optional

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
from hook_blocks_lib import attribute, follow, inventory, report, transcripts  # noqa: E402
from laptop import common  # noqa: E402

DAYS = 14


def find(projects: Path, since: float) -> List[Path]:
    out = []
    if not projects.is_dir():
        return out
    for p in sorted(list(projects.glob("*/*.jsonl")) + list(projects.glob("*/*/subagents/agent-*.jsonl"))):
        try:
            if p.stat().st_mtime >= since:
                out.append(p)
        except OSError:
            continue
    return out


def collect(*, projects: Path, claude_home: Path, copy: Path, hooks_log: Path, since: float,
            extra: List[str]) -> Dict:
    paths = find(projects, since)
    read = [transcripts.read(p) for p in paths]
    skipped = [dict(path=str(t.path), why=t.error) for t in read if t.error]
    partly = [dict(path=str(t.path), bad_lines=t.bad_lines) for t in read if not t.error and t.bad_lines]
    ok = [t for t in read if not t.error]
    folders = {s["folder"] for t in ok for s in t.steps if s.get("folder")}
    hooks, problems = inventory.build(claude_home=claude_home, copy=copy, folders=folders, extra=extra)
    log, why = attribute.read_hooks_log(hooks_log)
    if why:
        problems.append(why)
    found = []
    for t in ok:
        for i, step in enumerate(t.steps):
            if step["k"] != "block":
                continue
            when = attribute.epoch(step["ts"])
            if when is not None and when < since:
                continue
            action, note = follow.next_action(t.steps, i)
            found.append(dict(step, next=action, next_note=note, false_alarm=follow.false_alarm(step, action)))
    found.sort(key=lambda b: (attribute.epoch(b["ts"]) or 0, b["transcript"]))
    sources = attribute.Sources()
    for b in found:
        hook, how, cands = attribute.attribute(b, hooks, log, sources)
        b.update(hook=hook["id"] if hook else "unknown ({})".format(b["event"]), found_by=how, candidates=cands)
        if hook is not None and hook["id"] not in {h["id"] for h in hooks}:
            hooks.append(hook)
    return dict(hooks=hooks, blocks=found, skipped=skipped, partly=partly, read=len(ok), problems=problems)


def main(argv: Optional[List[str]] = None, now: Optional[datetime.datetime] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--days", type=int, default=DAYS, help="how far back to read (default %(default)s)")
    ap.add_argument("--claude-home", default=os.path.join(os.path.expanduser("~"), ".claude"))
    ap.add_argument("--settings-file", action="append", default=[],
                    help="another settings file sessions get with --settings (repeat for more)")
    ap.add_argument("--out-dir", default=None, help="a folder under ~/.josh-360 (default reviews/hook-blocks)")
    args = ap.parse_args(argv)
    now = now or datetime.datetime.now(datetime.timezone.utc)
    home = common.home()
    claude_home = Path(args.claude_home)
    copy = common.laptop_copy() if (common.laptop_copy() / "hooks").is_dir() else common.REPO_ROOT
    since = now.timestamp() - args.days * 86400
    data = collect(projects=claude_home / "projects", claude_home=claude_home, copy=copy,
                   hooks_log=common.logs_dir() / "hooks.log", since=since, extra=args.settings_file)
    meta = dict(generated=now.replace(microsecond=0).isoformat().replace("+00:00", "Z"), window_days=args.days,
                since=datetime.datetime.fromtimestamp(since, datetime.timezone.utc).strftime("%Y-%m-%d"),
                transcripts=dict(read=data["read"], skipped=data["skipped"], partly=data["partly"]),
                settings_problems=data["problems"])
    rows = report.summarise(data["hooks"], data["blocks"])
    lane = common.Lane(home)
    try:
        out_dir = lane.check(Path(args.out_dir) if args.out_dir else home / "reviews" / "hook-blocks")
    except common.Unexpected as e:
        print("hook_blocks: {}".format(e), file=sys.stderr)
        return 2
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = "hook-blocks-{}".format(now.strftime("%Y-%m-%d"))
    md, js = lane.check(out_dir / (stem + ".md")), lane.check(out_dir / (stem + ".json"))
    for path, text in ((md, report.markdown(meta, rows, data["blocks"])),
                       (js, json.dumps(report.as_json(meta, rows, data["blocks"]), indent=2) + "\n")):
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(text, encoding="utf-8")
        os.chmod(str(tmp), 0o600)
        os.replace(str(tmp), str(path))
    alarms = sum(1 for b in data["blocks"] if b["false_alarm"])
    print("Wrote {} (and {}): {} blocks, {} likely false alarms, {} hooks listed, {} transcripts read, {} skipped.".format(
        md, js.name, len(data["blocks"]), alarms, len(rows), data["read"], len(data["skipped"])))
    for r in rows:
        if r["blocks"]:
            print("  {}: {} blocks, {} likely false alarms".format(r["id"], r["blocks"], r["false_alarms"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
