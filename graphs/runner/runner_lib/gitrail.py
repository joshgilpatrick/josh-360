"""One branch and one worktree per ticket: the rail that refuses more inside a graph step's session (JP-174).

Python 3.9, standard library only. `prepare-worktree` makes the ticket's one branch `<KEY>-<slug>` and its one worktree
`<clone>/.claude/worktrees/<KEY>-<slug>`, and every later step and run reuses them. A step session works in that
worktree and never makes another: `refused` names what a Bash command would make, and `message` says which branch and
worktree the session already has. Committing, pushing and switching between existing branches are not this rail's
business (the guard's other rails cover writes for read-only steps).

Like the guard's other rails this reads shell text, so it narrows the obvious spellings and is not a boundary: a
command hidden behind a variable or a script file is not seen.
"""
from __future__ import annotations

import re
import shlex
from typing import List, Optional

# Where a command starts (the guard's own rule), then `git` and any of its global options before the subcommand.
START = r"(?:^|[;&|(\n]|\$\()\s*(?:[A-Za-z_]\w*=\S*\s+)*(?:(?:env|command|exec|sudo)\s+(?:[A-Za-z_]\w*=\S*\s+)*)?"
GIT = START + r"git\s+(?:(?:-C|-c|--git-dir|--work-tree|--namespace)(?:\s+|=)\S+\s+|--?[A-Za-z][\w-]*\s+)*"
WORKTREE_ADD = re.compile(GIT + r"worktree\s+add\b")
CHECKOUT_NEW = re.compile(GIT + r"checkout\b[^;&|\n]*?\s(?:-[A-Za-z]*[bB]|--orphan)(?=\s|=|$)")
SWITCH_NEW = re.compile(GIT + r"switch\b[^;&|\n]*?\s(?:-[A-Za-z]*[cC]|--create|--force-create|--orphan)(?=\s|=|$)")
BRANCH_ARGS = re.compile(GIT + r"branch\b([^;&|\n]*)")
CLAUDE_WORKTREE = re.compile(START + r"(?:\S*/)?claude\b[^;&|\n]*\s--worktree(?=\s|=|$)")
WORKTREE_TOOLS = ("EnterWorktree",)

# `git branch` options that only read, delete or set an upstream: with these, a name is not a new branch.
BRANCH_READS = {"-d", "-D", "--delete", "-l", "--list", "-a", "--all", "-r", "--remotes", "--show-current", "-v",
                "-vv", "--verbose", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "-u",
                "--set-upstream-to", "--unset-upstream", "--edit-description"}
BRANCH_READ_PREFIXES = ("--format", "--sort", "--column", "--no-column", "--color", "--no-color", "--abbrev",
                        "--set-upstream-to=", "--contains=", "--merged=", "--no-merged=", "--points-at=")
# `git branch` options that make a new name: copy and rename.
BRANCH_MAKES = {"-m", "-M", "--move", "-c", "-C", "--copy"}


def _words(text: str) -> List[str]:
    try:
        return shlex.split(text)
    except ValueError:
        return text.split()


def _branch_makes_one(args: str) -> bool:
    words = _words(args)
    flags = [w for w in words if w.startswith("-")]
    if any(f in BRANCH_MAKES for f in flags):
        return True
    if any(f in BRANCH_READS or f.startswith(BRANCH_READ_PREFIXES) for f in flags):
        return False
    return any(not w.startswith("-") for w in words)


def refused(command: str) -> Optional[str]:
    """What the command would make ("a worktree" or "a branch"), or None when it makes neither."""
    if WORKTREE_ADD.search(command) or CLAUDE_WORKTREE.search(command):
        return "a worktree"
    if CHECKOUT_NEW.search(command) or SWITCH_NEW.search(command):
        return "a branch"
    for found in BRANCH_ARGS.finditer(command):
        if _branch_makes_one(found.group(1)):
            return "a branch"
    return None


def message(what: str, ticket: Optional[str], branch: Optional[str], worktree: Optional[str],
            work_dir: Optional[str]) -> str:
    """The refusal: one branch and one worktree per ticket, and the ones this session already has."""
    who = ticket or "this ticket"
    if branch and worktree:
        return ("a step session does not make {}: {} has one branch, {}, and one worktree, {}. Work and commit there; "
                "the gates make, push and clean up the branch").format(what, who, branch, worktree)
    return ("a step session does not make {}: this run has no worktree for {}, so work in the work folder {}"
            .format(what, who, work_dir or "named in your prompt"))
