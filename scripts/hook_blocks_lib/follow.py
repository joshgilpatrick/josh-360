"""What the agent did after a block, and whether the block looks like a false alarm (JP-182).

Next action, read from the steps that follow the block in the same transcript (main session or subagent), up to the
next prompt or the agent's next attempt to stop:

  retried              the next call is the same tool with the same input
  other-way-succeeded  a call within the next three does the same job in other words (at least 60% of its words
                       and two or more in common, or another tool on the same file), and it worked
  other-way-failed     as above, but that call failed too
  asked-josh           it called AskUserQuestion, or ended the turn with a question
  gave-up              it ended the turn without trying again
  moved-on             it carried on with something unrelated
  continued            a Stop or SubagentStop block: the agent kept working, as the hook asked
  unknown              nothing follows the block in the transcript

A block is a likely false alarm (the ticket's rule) when the same goal was done straight after another way, or when
what was blocked deletes or changes nothing (a read-only command or tool). The agent reviewing the file decides.
"""
from __future__ import annotations

import re
import shlex
from typing import Dict, List, Optional, Tuple

LOOK_AHEAD = 3
SIMILAR = 0.6
READ_TOOLS = {"Read", "Grep", "Glob", "LS", "NotebookRead", "WebSearch", "WebFetch", "TaskGet", "TaskList",
              "ToolSearch", "BashOutput"}
FILE_TOOLS = {"Read", "Edit", "Write", "MultiEdit", "NotebookEdit"}
READ_COMMANDS = {"echo", "printf", "cat", "head", "tail", "less", "more", "ls", "pwd", "grep", "egrep", "rg", "ag",
                 "find", "wc", "sort", "uniq", "cut", "tr", "diff", "file", "stat", "which", "type", "whoami", "date",
                 "env", "printenv", "true", "test", "[", "jq", "du", "df", "ps", "pgrep", "realpath", "dirname",
                 "basename", "readlink", "tree", "sed", "awk", "column", "nl", "md5", "shasum", "sha256sum", "cd",
                 "curl"}
GIT_READ = {"log", "status", "diff", "show", "rev-parse", "ls-files", "ls-tree", "blame", "describe", "shortlog",
            "rev-list", "cat-file", "grep", "reflog", "fetch", "remote", "branch", "tag", "worktree", "config",
            "merge-base", "name-rev", "for-each-ref", "show-ref"}
GH_READ = {"view", "list", "diff", "checks", "status", "search"}
CHANGING_FLAGS = {"-d", "-D", "--delete", "-m", "-M", "--move", "-f", "--force", "--prune", "--set-upstream-to"}
WRITE_REDIRECT = re.compile(r"(?<![0-9&])>{1,2}(?!\s*/dev/null)(?!&)")


def words(text: str) -> set:
    return {w for w in re.findall(r"[a-z0-9_./-]{3,}", str(text).lower())}


def similarity(a: str, b: str) -> float:
    """Share of words in common; 0 unless at least two words are shared, so two short commands that only share a
    verb ("echo x one", "echo y one") are not the same job."""
    x, y = words(a), words(b)
    return len(x & y) / len(x | y) if len(x & y) >= 2 else 0.0


def _input_text(step: Dict) -> str:
    data = step.get("input") or {}
    return str(data.get("command") or data.get("file_path") or data.get("path") or data.get("url") or sorted(data.items()))


def _same_job(blocked: Dict, call: Dict) -> bool:
    if call.get("tool") == blocked.get("tool"):
        if call["tool"] in FILE_TOOLS:
            return (call.get("input") or {}).get("file_path") == (blocked.get("input") or {}).get("file_path")
        return similarity(_input_text(blocked), _input_text(call)) >= SIMILAR
    path = (call.get("input") or {}).get("file_path")
    if blocked.get("tool") == "Bash" and call.get("tool") in FILE_TOOLS and path:
        return path in _input_text(blocked) or path.rsplit("/", 1)[-1] in words(_input_text(blocked))
    return False


def _result(steps: List[Dict], start: int, call_id: str) -> Optional[Dict]:
    for s in steps[start:]:
        if s["k"] == "result" and s["id"] == call_id:
            return s
    return None


def _stream(steps: List[Dict], block: Dict) -> List[Dict]:
    """Main session and each subagent are separate streams of steps; a block is followed only in its own."""
    return [s for s in steps if s.get("agent", "") == block.get("agent", "")]


def next_action(steps: List[Dict], at: int) -> Tuple[str, str]:
    """(action, a short note on the step that decided it) for the block at steps[at]."""
    block = steps[at]
    stream = _stream(steps[at + 1:], block)
    after: List[Dict] = []
    for s in stream:
        if s["k"] == "prompt":
            break
        if s["k"] == "block" and s["event"] in ("Stop", "SubagentStop") and block["event"] not in ("Stop", "SubagentStop"):
            break  # the agent tried to end the turn there; what follows is the stop hook's doing
        after.append(s)
    if block["event"] == "UserPromptSubmit":
        prompt = next((s for s in stream if s["k"] == "prompt"), None)
        if prompt is None:
            return "unknown", "no later prompt"
        if similarity(block.get("prompt", ""), prompt["text"]) >= SIMILAR:
            return "other-way-succeeded", "the next prompt says the same in other words"
        return "moved-on", "the next prompt is about something else"
    if block["event"] in ("Stop", "SubagentStop"):
        return ("continued", "kept working after the block") if after else ("unknown", "nothing follows the block")
    if not after:
        return "unknown", "nothing follows the block"
    blocked = block.get("call") or {}
    calls = [s for s in after if s["k"] == "call"]
    if not calls:
        text = " ".join(s["text"] for s in after if s["k"] == "text").strip()
        return ("asked-josh", "ended the turn with a question") if text.rstrip().endswith("?") or "?\n" in text \
            else ("gave-up", "ended the turn without trying again")
    if calls[0].get("tool") == "AskUserQuestion":
        return "asked-josh", "called AskUserQuestion"
    if blocked and calls[0].get("tool") == blocked.get("tool") and calls[0].get("input") == blocked.get("input"):
        return "retried", "ran the same call again"
    for c in calls[:LOOK_AHEAD]:
        if blocked and _same_job(blocked, c):
            r = _result(after, 0, c["id"])
            ok = r is not None and not r["error"]
            return ("other-way-succeeded" if ok else "other-way-failed",
                    "{}: {}".format(c.get("tool"), _input_text(c)[:120]))
    return "moved-on", "next: {}".format(calls[0].get("tool"))


def _segments(command: str) -> List[List[str]]:
    out = []
    for part in re.split(r"\|\||&&|[|;\n]|\$\(|`", command):
        try:
            w = shlex.split(part, comments=True)
        except ValueError:
            w = part.split()
        while w and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", w[0]):  # VAR=value before the command
            w = w[1:]
        if w:
            out.append(w)
    return out


def _git_reads(w: List[str]) -> bool:
    sub = next((x for x in w[1:] if not x.startswith("-")), "")
    if sub not in GIT_READ or set(w[2:]) & CHANGING_FLAGS:
        return False
    rest = [x for x in w[w.index(sub) + 1:] if not x.startswith("-")]
    if sub in ("branch", "tag"):
        return not rest  # a name creates one
    if sub == "worktree":
        return rest[:1] == ["list"]
    if sub == "remote":
        return not rest or rest[0] in ("show", "get-url")
    if sub == "config":
        return bool({"--get", "--get-all", "--list", "-l", "--get-regexp"} & set(w))
    return True


def changes_nothing(tool: Optional[str], data) -> bool:
    """True when the blocked call only reads: a read-only tool, or a Bash command whose every part is a read."""
    if tool in READ_TOOLS:
        return True
    if tool != "Bash" or not isinstance(data, dict):
        return False
    command = str(data.get("command") or "")
    if not command.strip() or WRITE_REDIRECT.search(command):
        return False
    for w in _segments(command):
        verb = w[0].rsplit("/", 1)[-1]
        if verb in ("sudo", "xargs", "eval", "exec", "rm", "mv"):
            return False
        if verb == "git":
            if not _git_reads(w):
                return False
        elif verb == "gh":
            rest = [x for x in w[1:] if not x.startswith("-")]
            if rest[:1] == ["api"]:
                if set(w) & {"-X", "--method", "-f", "-F", "--field", "--raw-field", "--input"}:
                    return False
            elif len(rest) < 2 or rest[1] not in GH_READ:
                return False
        elif verb in ("sed",) and ({"-i", "--in-place"} & set(w) or any(x.startswith("-i") for x in w[1:])):
            return False
        elif verb == "find" and {"-delete", "-exec", "-execdir", "-ok"} & set(w):
            return False
        elif verb in ("python3", "python", "node", "sqlite3", "curl"):
            if verb == "curl" and not ({"-X", "--request", "-d", "--data", "-F", "--form", "-T"} & set(w)):
                continue
            return False  # a program can do anything
        elif verb not in READ_COMMANDS:
            return False
    return True


def false_alarm(block: Dict, action: str) -> Optional[str]:
    """The reason a block looks like a false alarm, or None."""
    if action == "other-way-succeeded":
        return "done straight after another way"
    if block["event"] == "PreToolUse" and changes_nothing(block.get("tool"), (block.get("call") or {}).get("input")):
        return "the blocked call changes nothing"
    return None
