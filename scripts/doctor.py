#!/usr/bin/env python3
"""The Josh 360 doctor (JP-152): is every part of the platform present and configured on this laptop?

    python3 ~/.josh-360/repo/scripts/doctor.py              run every check, print one line each, then what is left to do
    python3 ~/.josh-360/repo/scripts/doctor.py --json       the same as one JSON document, for an agent
    python3 ~/.josh-360/repo/scripts/doctor.py --online     also ask GitHub and Jira (read-only calls)
    python3 ~/.josh-360/repo/scripts/doctor.py --fix        then do the few safe, reversible fixes (see doctor_lib/fixes.py)
    python3 ~/.josh-360/repo/scripts/doctor.py --fix --dry-run   say what --fix would do

Read-only unless --fix. Each line is PASS, WARN, FAIL or SKIP; a FAIL (or a WARN with --strict) makes the exit code 1.
A FAIL or WARN line is followed by the one step that fixes it. No token, email address or row text is ever printed.
Exit codes: 0 nothing failed, 1 something failed, 2 the command was misused.

Python 3.9, standard library only: run it with /usr/bin/python3 on the laptop.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Dict, List, Optional, Sequence

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from doctor_lib import core, fixes  # noqa: E402
from doctor_lib import install_checks, hook_checks, data_checks, service_checks, graph_checks, manual  # noqa: E402,F401,I001  (this order is the report's order)

SCHEMA = 1
TITLES = {
    "install": "Install and follow", "jobs": "Background jobs", "backfills": "One-time jobs and backfills",
    "hooks": "Claude Code hooks", "data": "Databases", "evidence": "Signs of real use",
    "services": "Services", "accounts": "Accounts and tools", "graphs": "Graphs and walker", "owed": "Dates owed",
}
COLOURS = {"pass": "32", "warn": "33", "fail": "31", "skip": "90"}


def report(ctx: core.Ctx, results: Sequence[core.Result], applied: List[Dict[str, str]]) -> Dict[str, object]:
    summary = core.summarise(results)
    return {
        "schema": SCHEMA, "time": ctx.now.strftime("%Y-%m-%dT%H:%M:%SZ"), "ok": summary["fail"] == 0,
        "summary": summary, "laptop_copy": ctx.tilde(ctx.copy), "checks": [r.as_dict() for r in results],
        "fixes": applied, "manual": manual.MANUAL,
    }


def render(ctx: core.Ctx, results: Sequence[core.Result], applied: List[Dict[str, str]], colour: bool,
           show_manual: bool, strict: bool) -> str:
    def tag(status: str) -> str:
        text = status.upper().ljust(4)
        return "\x1b[{}m{}\x1b[0m".format(COLOURS[status], text) if colour else text

    lines = ["Josh 360 doctor  {}  (laptop copy {})".format(ctx.now.strftime("%Y-%m-%d %H:%M UTC"), ctx.tilde(ctx.copy))]
    group = ""
    for r in results:
        if r.group != group:
            group = r.group
            lines += ["", TITLES.get(group, group).upper()]
        lines.append("  {}  {:<32} {}".format(tag(r.status), r.id, r.detail))
        if r.fix and r.status in ("fail", "warn"):
            lines.append("        fix: " + r.fix)
    if applied:
        lines += ["", "FIXES"]
        for a in applied:
            lines.append("  {:<10} {:<11} {}".format(a["outcome"], a["fix"], a["detail"]))
    if show_manual:
        lines += ["", "ONLY YOU CAN CHECK (the doctor cannot see these; not counted above)"]
        for m in manual.MANUAL:
            lines += ["  [{}] {}".format(m["ticket"], m["what"]), "        how: " + m["how"]]
    summary = core.summarise(results)
    failed = summary["fail"] > 0 or (strict and summary["warn"] > 0)
    auto = [r.id for r in results if r.fix_key and r.status in ("fail", "warn")]
    lines += ["", "Summary: {} pass, {} warn, {} fail, {} skipped. {}".format(
        summary["pass"], summary["warn"], summary["fail"], summary["skip"],
        "Exit 1: something needs fixing." if failed else "Exit 0.")]
    if auto and not applied:
        lines.append("{} can be fixed safely and reversibly with: python3 ~/.josh-360/repo/scripts/doctor.py --fix".format(
            ", ".join(auto[:4]) + (" and {} more".format(len(auto) - 4) if len(auto) > 4 else "")))
    return "\n".join(lines)


def main(argv: Optional[Sequence[str]] = None, ctx: Optional[core.Ctx] = None) -> int:
    parser = argparse.ArgumentParser(description="Check that every part of Josh 360 is present and configured on this laptop.")
    parser.add_argument("--json", action="store_true", help="print one JSON document instead of text")
    parser.add_argument("--online", action="store_true", help="also make read-only calls to GitHub and Jira")
    parser.add_argument("--fix", action="store_true", help="do the safe, reversible fixes, then check again")
    parser.add_argument("--dry-run", action="store_true", help="with --fix: say what would be done, change nothing")
    parser.add_argument("--jira-email", help="with --fix: write the Jira account email setting")
    parser.add_argument("--strict", action="store_true", help="exit 1 on a WARN too")
    parser.add_argument("--only", action="append", metavar="GROUP", help="run only this group (repeatable)")
    parser.add_argument("--no-manual", action="store_true", help="leave the list of manual checks out of the text")
    args = parser.parse_args(list(argv) if argv is not None else None)
    if args.dry_run and not args.fix:
        parser.error("--dry-run only goes with --fix")
    if args.jira_email and not args.fix:
        parser.error("--jira-email only goes with --fix")
    known = {g for g, _, _ in core.REGISTRY}
    for g in args.only or []:
        if g not in known:
            parser.error("unknown group {!r}; groups are: {}".format(g, ", ".join(sorted(known))))

    ctx = ctx or core.Ctx(online=args.online)
    results = core.run_checks(ctx, args.only)
    applied: List[Dict[str, str]] = []
    if args.fix:
        keys = fixes.plan(results, args.jira_email)
        applied = fixes.apply(ctx, keys, args.jira_email, args.dry_run)
        if applied and not args.dry_run:
            ctx = core.Ctx(home=ctx.home, user_home=ctx.user_home, env=ctx.env, runner=ctx.run, http_get=ctx.http_get,
                           online=ctx.online, code_root=ctx.code_root, jira_fetch=ctx.jira_fetch)  # forget what was cached
            results = core.run_checks(ctx, args.only)
    summary = core.summarise(results)
    if args.json:
        print(json.dumps(report(ctx, results, applied), indent=2, sort_keys=True))
    else:
        colour = sys.stdout.isatty() and "NO_COLOR" not in os.environ
        print(render(ctx, results, applied, colour, not args.no_manual and not args.only, args.strict))
    return 1 if summary["fail"] or (args.strict and summary["warn"]) else 0


if __name__ == "__main__":
    sys.exit(main())
