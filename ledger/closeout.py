"""The closeout script: proposes an action for each loose end and carries out the reversible ones (JP-109).

    python3 ledger/closeout.py [--session <id>] [--json] [--fetch]                      show the proposals, change nothing
    python3 ledger/closeout.py --apply [--session <id>] [--only <item id>]...           carry out the script's own actions

Josh calls this (usually through the closeout agent, `.claude/agents/closeout.md`). Nothing schedules or reminds. Each item
from `ledger/loose_ends.py` gets one proposal with a `by`:

    script   reversible, and `--apply` does it: push a branch that is on no remote (never forced, never the default
             branch), save commits that are on no branch under `rescue/<sha>`, delete a local branch that is already
             merged into the default branch (`git branch -d`, which refuses anything unmerged), remove a worktree
             that holds nothing at all (clean, no ignored files, its commits already on a remote branch or the default
             branch).
    agent    the closeout agent's own step (a ticket: move it to Done only when the merged work proves it).
    josh     Josh decides: an open pull request, a branch pushed and forgotten, a worktree with uncommitted or
             unpushed work, anything in a `.phi` folder. These are listed with the reason and never touched here.

The rules that keep work safe: no force flag anywhere; no remote branch is ever deleted; nothing is removed whose
commits exist nowhere else (they stay, and Josh is asked); every action is checked again just before it runs, against
git as it is then. Josh approves every permanent deletion.
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import subprocess
import sys
from pathlib import Path
from typing import Dict, List, Optional, TextIO

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from ledger import _repo  # noqa: E402,F401
from ledger import ask, db, loose_ends  # noqa: E402
from ledger.live import Live  # noqa: E402

BY = "ledger/closeout.py"


def _phi(conn: sqlite3.Connection, item: dict) -> bool:
    """True when the item touches a `.phi` folder: the script leaves those to Josh."""
    paths = [item.get("root") or "", item.get("path") or ""]
    marks = ",".join("?" for _ in item["sessions"])
    paths += [r[0] or "" for r in conn.execute(
        "SELECT folder FROM current_session_episodes WHERE session_uid IN ({})".format(marks), item["sessions"])]
    return any(".phi" in p.replace("\\", "/").split("/") for p in paths)


def _remote(repo: loose_ends.Repo) -> Optional[str]:
    names = (loose_ends.git(repo.root, "remote") or "").split()
    return "origin" if "origin" in names else (names[0] if len(names) == 1 else None)


def _proposal(item: dict, by: str, action: str, why: str, reversible: bool = False,
              argv: Optional[List[str]] = None) -> dict:
    return {"id": item["id"], "kind": item["kind"], "by": by, "action": action, "why": why, "reversible": reversible,
            "argv": argv}


def propose(conn: sqlite3.Connection, item: dict, repo: Optional[loose_ends.Repo]) -> dict:
    kind = item["kind"]
    if kind in ("open-pr", "ticket-not-done"):
        if kind == "open-pr":
            return _proposal(item, "josh", "merge or close the pull request", "that is Josh's call")
        return _proposal(item, "agent", "check the merged work, then move the ticket to Done",
                         "only when a merged pull request or commits on the default branch prove it")
    if kind == "closed-pr-branch":
        return _proposal(item, "josh", "delete the remote branch or mark it kept",
                         "its pull request was closed without merging, so the branch may be the only copy of that work; "
                         "deleting a remote branch is permanent")
    if repo is None or not repo.ok:
        return _proposal(item, "josh", "look at it by hand", "git could not be read in that repository")
    if _phi(conn, item):
        return _proposal(item, "josh", "decide what to do", "it touches a .phi folder, so the script does not act on it")
    root = repo.root
    if kind == "unpushed-branch":
        remote = _remote(repo)
        if remote is None:
            return _proposal(item, "josh", "choose a remote to push to", "no single remote to push to")
        return _proposal(item, "script", "push the branch to " + remote, "it exists only on this laptop", True,
                         ["git", "-C", root, "push", "-u", remote, item["branch"]])
    if kind == "commits-unhoused":
        return _proposal(item, "script", "save the commits on branch rescue/" + item["commit"][:9],
                         "they are on no branch; check GitHub first if the work may have been squash-merged", True,
                         ["git", "-C", root, "branch", "rescue/" + item["commit"][:9], item["commit"]])
    if kind == "orphaned-branch":
        if item.get("state_name") == "merged":
            return _proposal(item, "script", "delete the local branch", "it is already merged; its tip is "
                             "kept in this output for recovery", True, ["git", "-C", root, "branch", "-d", item["branch"]])
        return _proposal(item, "josh", "open a pull request, mark it kept, or delete it",
                         "it was pushed but never merged, so the work lives on the remote only")
    if kind == "leftover-worktree":
        if item["folder_exists"] and (item["uncommitted"] or item["ignored_files"]):
            return _proposal(item, "josh", "decide about the worktree's files", "it holds {} changed and {} ignored "
                             "files that exist nowhere else".format(item["uncommitted"], item["ignored_files"]))
        if item["folder_exists"] and item["head"] not in repo.housed():
            return _proposal(item, "josh", "decide about the worktree's commits",
                             "its commits are on no branch, remote branch or tag")
        if item["folder_exists"] and item["branch"] and not (repo.pushed(item["branch"]) or repo.merged(item["branch"])):
            return _proposal(item, "josh", "push or keep the worktree's branch", "its commits exist only on this laptop")
        return _proposal(item, "script", "remove the worktree", "it holds nothing that is not already on a remote "
                         "branch or the default branch", True, ["git", "-C", root, "worktree", "remove", item["path"]])
    return _proposal(item, "josh", "look at it by hand", "no rule for this kind")


def _still_true(conn: sqlite3.Connection, plan: dict, live: Live) -> bool:
    """The item is loose now, as git is now, and its proposal is still the same one."""
    now = loose_ends.collect(conn, live)
    for item in now["items"]:
        if item["id"] == plan["id"]:
            repo = loose_ends.Repo(item["root"]) if item.get("root") else None
            again = propose(conn, item, repo)
            return again["by"] == "script" and again["argv"] == plan["argv"]
    return False


def plan_all(conn: sqlite3.Connection, live: Live, session: Optional[str] = None, fetch: bool = False,
             now: Optional[str] = None) -> dict:
    result = loose_ends.collect(conn, live, now, session, fetch)
    repos: Dict[str, loose_ends.Repo] = {}
    plans = []
    for item in result["items"]:
        root = item.get("root")
        repo = repos.setdefault(root, loose_ends.Repo(root)) if root else None
        plans.append(dict(propose(conn, item, repo), age_days=item["age_days"], detail=item["detail"],
                          branch=item.get("branch"), root=root, sessions=item["sessions"]))
    return {"as_of": result["as_of"], "plans": plans, "unchecked": result["unchecked"]}


def apply(conn: sqlite3.Connection, plans: List[dict], live: Live, only: Optional[List[str]] = None) -> List[dict]:
    """Carry out the script's own, reversible actions. Returns what happened to each."""
    results = []
    for plan in plans:
        if plan["by"] != "script" or not plan["reversible"] or (only and plan["id"] not in only):
            continue
        if not _still_true(conn, plan, live):
            results.append({"id": plan["id"], "action": plan["action"], "done": False,
                            "output": "skipped: it is no longer a loose end, or git changed since the list was made"})
            continue
        tip = ""
        if plan["argv"][3:5] == ["branch", "-d"]:  # the tip is kept in the output, so the branch can be recreated
            tip = (loose_ends.git(plan["argv"][2], "rev-parse", plan["argv"][5]) or "").strip()
        done = subprocess.run(plan["argv"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, universal_newlines=True,
                              timeout=300)
        output = done.stdout.strip()[-400:]
        if tip:
            output = (output + " (branch tip was " + tip + ")").strip()
        results.append({"id": plan["id"], "action": plan["action"], "done": done.returncode == 0, "output": output})
    return results


def render_text(report: dict) -> str:
    plans = report["plans"]
    lines = ["Closeout: {} loose end{} as of {}".format(len(plans), "" if len(plans) == 1 else "s", report["as_of"])]
    for who, label in (("script", "I can do these (reversible)"), ("agent", "The closeout agent checks these"),
                       ("josh", "Josh decides these")):
        group = [p for p in plans if p["by"] == who]
        if not group:
            continue
        lines += ["", "{} ({})".format(label, len(group))]
        for p in group:
            lines.append("  {}d  {}  ->  {}  ({})".format(p["age_days"], p["id"], p["action"], p["why"]))
    if not plans:
        lines.append("Nothing is loose.")
    if report["unchecked"]:
        lines += ["", "Could not check (not clean, only unknown):"]
        lines += ["  {} x {}".format(u["count"], u["reason"]) for u in report["unchecked"]]
    return "\n".join(lines)


def main(argv: Optional[List[str]] = None, out: Optional[TextIO] = None, path: Optional[Path] = None,
         live: Optional[Live] = None, now: Optional[str] = None) -> int:
    out = out or sys.stdout
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--session")
    p.add_argument("--apply", action="store_true", help="carry out the script's reversible actions")
    p.add_argument("--only", action="append", help="with --apply: only this item id (repeatable)")
    p.add_argument("--json", action="store_true")
    p.add_argument("--fetch", action="store_true", help="git fetch --prune in each repository first")
    args = p.parse_args(argv)
    live = live or Live()
    try:
        conn = ask.open_read_only(path or db.ledger_path())
        try:
            report = plan_all(conn, live, args.session, args.fetch, now)
            results = apply(conn, report["plans"], live, args.only) if args.apply else None
        finally:
            conn.close()
    except (FileNotFoundError, sqlite3.Error, ValueError) as e:
        print("closeout: {}".format(e), file=sys.stderr)
        return 2
    if results is not None:
        report["results"] = results
    if args.json:
        out.write(json.dumps(report, sort_keys=True, indent=1) + "\n")
    else:
        out.write(render_text(report) + "\n")
        for r in results or []:
            out.write("{} {}: {}\n".format("DONE" if r["done"] else "NOT DONE", r["id"], r["output"]))
    return 0 if not results or all(r["done"] for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
