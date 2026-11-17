"""The one-line ticket offer (JP-110). Python 3.9, standard library only.

When a session is about to make its first commit, or create its first branch, and nothing ties it to a ticket, the
agent says one line to Josh and carries on. This file holds the three parts:

  - the hook body (`hook_main`), run by hooks/PreToolUse/30-ticket-offer on every Bash call. It decides quickly,
    never blocks (it always exits 0), and when it offers it prints `additionalContext` for the agent. It never
    writes the ledger: it creates a marker file, appends one spool line and prints.
  - the answer command (`python3 ledger/offer.py --session <id> accepted <KEY>|declined`), which the offer's text
    tells the agent to run once Josh answers. It only appends one more spool line. The agent never writes the ledger.
  - `write_offer`, which the recorder (ledger/record.py) calls for each `TicketOffer` spool line: one
    `ticket_offers` row, and for a yes one `ticket_links` row (source `offer`).

A session counts as ticketed, and gets no offer, when any of these holds (all cheap, none uses a model): its branch,
or the branch it is creating, starts with a ticket key; the walker, the daemon or the desk started it; the ledger
already ties it to a ticket; or it was offered once already. The ledger is opened read-only and a failed read means
"no link known". No answer is a missing row: nothing guesses.

Every spool line holds only: event, at, session_id, offer_event, offer_trigger, ticket_key. No prompt, command text
or message text is kept.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import sqlite3
import subprocess
import sys
import time
from pathlib import Path
from typing import Dict, List, NamedTuple, Optional, TextIO
from urllib.parse import quote

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from ledger import _repo  # noqa: E402,F401  (puts the repo root on sys.path)
from laptop import common  # noqa: E402
from ledger import spool  # noqa: E402

EVENT = "TicketOffer"
OFFER_EVENTS = ("offered", "accepted", "declined")
TRIGGERS = ("first-commit", "first-branch")
# The same pattern as ledger/homes.py's TICKET_BRANCH (a test keeps them equal); homes is not imported here because
# this runs on every Bash call and homes pulls in the conventions reader.
TICKET_BRANCH = re.compile(r"^([A-Z][A-Z0-9]+-[0-9]+)([/-]|$)")
TICKET_KEY = re.compile(r"^[A-Z][A-Z0-9]+-[0-9]+$")
STAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
# Sessions the system itself started carry a ticket by construction (the same rules the SessionStart spool line uses).
TICKETED_STARTERS = ("walker", "daemon", "desk")
# Ticket links the ledger may hold that count as "this session has a ticket". A link from the branch is the same fact
# as the branch name, which is read directly.
LINK_SOURCES = ("daemon", "walker", "offer", "josh", "jira-command", "backfill")
LINK_RELATIONS = ("touched", "subject", "created")
ONE_LINE = "This has become ticket-sized work, want me to open a ticket?"
KEEP_DAYS = 30
GIT_TIMEOUT = 3
BY = "ledger/offer.py"

_OPERATORS = set(";&|()<>")
_WRAPPERS = ("command", "time", "exec", "nohup", "env", "builtin")
_BRANCH_FLAGS_OK = ("-f", "--force", "-t", "--track", "--no-track", "-q", "--quiet")


class Trigger(NamedTuple):
    kind: str                 # first-commit or first-branch
    branch: Optional[str]     # the new branch's name, for first-branch
    directory: Optional[str]  # the folder given with `git -C`, if any


# -- reading the command -----------------------------------------------------------------------------------------


def _segments(command: str) -> List[List[str]]:
    """The command split into simple commands at ; && || | & and newlines. A command that does not tokenise (an open
    quote) gives no segments: nothing is claimed about it."""
    try:
        lexer = shlex.shlex(command.replace("\n", " ; "), posix=True, punctuation_chars=True)
        lexer.whitespace_split = True
        tokens = list(lexer)
    except ValueError:
        return []
    out: List[List[str]] = [[]]
    for tok in tokens:
        if tok and all(ch in _OPERATORS for ch in tok):
            out.append([])
        else:
            out[-1].append(tok)
    return [s for s in out if s]


def _git_call(tokens: List[str]):
    """(directory, subcommand, args) when the simple command is a git call, else None."""
    i = 0
    while i < len(tokens) and (re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", tokens[i]) or tokens[i] in _WRAPPERS):
        i += 1
    if i >= len(tokens) or os.path.basename(tokens[i]) != "git":
        return None
    i += 1
    directory = None
    while i < len(tokens):
        tok = tokens[i]
        if tok == "-C" and i + 1 < len(tokens):
            directory = tokens[i + 1]
            i += 2
        elif tok == "-c" and i + 1 < len(tokens):
            i += 2
        elif tok.startswith("-"):
            i += 1
        else:
            break
    if i >= len(tokens):
        return None
    return directory, tokens[i], tokens[i + 1:]


def _flag_value(args: List[str], flags) -> Optional[str]:
    """The word after the first of `flags` in args, when it is not itself an option."""
    for n, tok in enumerate(args):
        if tok in flags:
            nxt = args[n + 1] if n + 1 < len(args) else None
            return nxt if nxt and not nxt.startswith("-") else None
    return None


def triggers(command: str) -> List[Trigger]:
    """Every first-commit and first-branch moment in a Bash command, in the order they appear."""
    found: List[Trigger] = []
    for tokens in _segments(command):
        call = _git_call(tokens)
        if call is None:
            continue
        directory, sub, args = call
        if sub == "commit":
            if "--dry-run" not in args and "-h" not in args and "--help" not in args:
                found.append(Trigger("first-commit", None, directory))
        elif sub == "checkout":
            name = _flag_value(args, ("-b", "-B"))
            if name:
                found.append(Trigger("first-branch", name, directory))
        elif sub == "switch":
            name = _flag_value(args, ("-c", "-C", "--create", "--force-create"))
            if name:
                found.append(Trigger("first-branch", name, directory))
        elif sub == "branch":
            if args and all(a in _BRANCH_FLAGS_OK or not a.startswith("-") for a in args):
                names = [a for a in args if not a.startswith("-")]
                if names:
                    found.append(Trigger("first-branch", names[0], directory))
        elif sub == "worktree" and args[:1] == ["add"]:
            name = _flag_value(args[1:], ("-b", "-B"))
            if name:
                found.append(Trigger("first-branch", name, directory))
    return found


# -- the marker: once per session ---------------------------------------------------------------------------------


def marker_dir() -> Path:
    return common.state_dir() / "ticket-offer"


def _log(message: str) -> None:
    try:
        common.logs_dir().mkdir(parents=True, exist_ok=True)
        with (common.logs_dir() / "hooks.log").open("a", encoding="utf-8") as f:
            f.write("{} ticket-offer {}\n".format(common.now_utc(), message))
    except OSError:
        pass


def _claim(folder: Path, sid: str, content: Dict[str, object]) -> bool:
    """Create <folder>/<sid> holding `content`, atomically and only if it does not exist. The content is written to a
    temporary file first, then linked into place, so nobody ever reads a half-written marker."""
    folder.mkdir(parents=True, exist_ok=True)
    tmp = folder / ".{}.{}".format(sid, os.getpid())
    tmp.write_text(json.dumps(content, sort_keys=True) + "\n", encoding="utf-8")
    try:
        os.link(str(tmp), str(folder / sid))
        return True
    except FileExistsError:
        return False
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass


def _prune(now_epoch: float) -> None:
    """Markers older than KEEP_DAYS go: a session is not resumed after that long, and the folder stays small."""
    for sub in ("offered", "answered"):
        try:
            for entry in (marker_dir() / sub).iterdir():
                if entry.stat().st_mtime < now_epoch - KEEP_DAYS * 86400:
                    entry.unlink()
        except OSError:
            pass


# -- is the session already ticketed? ------------------------------------------------------------------------------


def current_branch(folder: str) -> Optional[str]:
    """The branch HEAD names in `folder` (an unborn branch too), or None when git cannot say."""
    if not folder or not os.path.isdir(folder):
        return None
    try:
        out = subprocess.run(["git", "-C", folder, "symbolic-ref", "--short", "-q", "HEAD"], timeout=GIT_TIMEOUT,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
    except (OSError, subprocess.SubprocessError):
        return None
    return out.stdout.strip() or None if out.returncode == 0 else None


def has_ticket_link(sid: str) -> bool:
    """True when the ledger already ties this session to a ticket. Read-only, best effort: a ledger that is missing,
    locked or unreadable answers False (no link known), and the offer carries on."""
    path = common.state_dir() / "ledger.db"
    if not path.is_file():
        return False
    try:
        conn = sqlite3.connect("file:{}?mode=ro".format(quote(str(path))), uri=True, timeout=0.5)
        try:
            row = conn.execute(
                "SELECT 1 FROM ticket_links l JOIN sessions s ON s.session_uid = l.session_uid "
                "WHERE s.tool_session_id = ? AND l.relation IN ({}) AND l.source IN ({}) "
                "AND NOT EXISTS (SELECT 1 FROM live_corrections c WHERE c.table_name = 'ticket_links' "
                "AND c.row_id = l.id) LIMIT 1".format(",".join("?" * len(LINK_RELATIONS)),
                                                      ",".join("?" * len(LINK_SOURCES))),
                (sid,) + LINK_RELATIONS + LINK_SOURCES).fetchone()
            return row is not None
        finally:
            conn.close()
    except sqlite3.Error:
        return False


# -- the spool ----------------------------------------------------------------------------------------------------


def append_line(folder: Path, fields: Dict[str, object], at: str) -> None:
    line = {"event": EVENT, "at": at, "session_id": fields.get("session_id"), "offer_event": fields.get("offer_event"),
            "offer_trigger": fields.get("offer_trigger"), "ticket_key": fields.get("ticket_key")}
    spool.write_line(folder, line, at)


def offer_text(sid: str, trigger: str) -> str:
    moment = "make its first commit" if trigger == "first-commit" else "create its first branch"
    script = Path(__file__).resolve()
    return (
        "Josh 360 ticket offer (JP-110). This session is about to {moment} and no ticket is linked to it. Tell Josh "
        "once, in one line, in your next message: \"{line}\" Then carry on with what you were doing: do not wait for "
        "the answer, do not hold the commit, and do not ask again in this session.\n"
        "If Josh says yes: open the ticket (Josh's using-jira flow until the ticket creation graph exists), name the "
        "branch after its key (<KEY>/<slug>), then run: python3 {script} --session {sid} accepted <KEY>\n"
        "If Josh says no: run: python3 {script} --session {sid} declined\n"
        "If he does not answer, do nothing more."
    ).format(moment=moment, line=ONE_LINE, script=script, sid=sid)


# -- the hook -----------------------------------------------------------------------------------------------------


def decide(data: object) -> Optional[Trigger]:
    """The trigger to offer for, or None. Cheap checks first; the marker is not touched here."""
    if not isinstance(data, dict) or data.get("tool_name") != "Bash":
        return None
    sid = data.get("session_id")
    tool_input = data.get("tool_input")
    command = tool_input.get("command") if isinstance(tool_input, dict) else None
    if not isinstance(sid, str) or not spool.SESSION_ID.match(sid) or not isinstance(command, str):
        return None
    found = triggers(command) if "git" in command else []
    if not found:
        return None
    if any(t.kind == "first-branch" and TICKET_BRANCH.match(t.branch or "") for t in found):
        return None  # it is creating a branch named after a ticket
    if (marker_dir() / "offered" / sid).exists():
        return None
    if spool.started_by(os.environ) in TICKETED_STARTERS:
        return None
    first = found[0]
    if first.kind == "first-commit":
        cwd = data.get("cwd") if isinstance(data.get("cwd"), str) else ""
        folder = first.directory
        if folder and cwd and not os.path.isabs(folder):
            folder = os.path.join(cwd, folder)
        branch = current_branch(folder or cwd)
        if branch is None or TICKET_BRANCH.match(branch):
            return None  # no branch to judge by, or it is named after a ticket
    if has_ticket_link(sid):
        return None
    return first


def hook_main(stdin: TextIO, stdout: TextIO) -> int:
    """The hook body. Always 0: it never blocks a command, and an error is logged (without the input) and skipped."""
    try:
        data = json.loads(stdin.read())
        trigger = decide(data)
        if trigger is None:
            return 0
        sid = data["session_id"]
        now = common.now_utc()
        if not _claim(marker_dir() / "offered", sid, {"offered_at": now, "trigger": trigger.kind}):
            return 0  # another hook for this session got there first
        _prune(time.time())
        try:
            append_line(spool.spool_dir(), {"session_id": sid, "offer_event": "offered", "offer_trigger": trigger.kind},
                        now)
        except Exception as e:  # noqa: BLE001  (the offer still goes out; the ledger row is the recorder's)
            _log("spool failed: {}".format(type(e).__name__))
        stdout.write(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse",
                                                        "additionalContext": offer_text(sid, trigger.kind)}}) + "\n")
    except Exception as e:  # noqa: BLE001
        _log("failed: {}".format(type(e).__name__))
    return 0


# -- the answer command -------------------------------------------------------------------------------------------


def answer(sid: str, answer_kind: str, ticket_key: Optional[str], now: str) -> str:
    """Record Josh's answer for an open offer. Returns what to print. Raises LookupError when no offer is open and
    ValueError for a bad answer. Only the first answer counts."""
    if not spool.SESSION_ID.match(sid):
        raise ValueError("that is not a session id")
    if answer_kind == "accepted":
        if not ticket_key or not TICKET_KEY.match(ticket_key) or len(ticket_key) > 20:
            raise ValueError("accepted needs the ticket key, like JP-123")
    elif answer_kind == "declined":
        if ticket_key:
            raise ValueError("declined takes no ticket key")
    else:
        raise ValueError("the answer is accepted or declined")
    if not (marker_dir() / "offered" / sid).is_file():
        raise LookupError("no ticket offer is open for this session")
    mine = {"answer": answer_kind, "ticket_key": ticket_key}
    if not _claim(marker_dir() / "answered", sid, mine):
        return "already answered; nothing more to record"
    append_line(spool.spool_dir(), {"session_id": sid, "offer_event": answer_kind, "ticket_key": ticket_key}, now)
    return "recorded: {}".format(answer_kind)


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="offer.py", description="Record Josh's answer to the ticket offer (JP-110).")
    parser.add_argument("--session", required=True, help="the session id given in the offer")
    parser.add_argument("answer", choices=("accepted", "declined"))
    parser.add_argument("ticket", nargs="?", help="the ticket key, for accepted")
    args = parser.parse_args(argv)
    try:
        print(answer(args.session, args.answer, args.ticket, common.now_utc()))
    except ValueError as e:
        print("offer.py: {}".format(e), file=sys.stderr)
        return 2
    except LookupError as e:
        print("offer.py: {}".format(e), file=sys.stderr)
        return 1
    return 0


# -- the recorder's half ------------------------------------------------------------------------------------------


def write_offer(conn: sqlite3.Connection, line: Dict[str, object], now: str, registry: dict, by: str = BY) -> int:
    """Write the ledger rows for one TicketOffer spool line, inside the caller's transaction. Returns the number of
    ticket_offers rows written (0 for a line already written). Raises ValueError for a line that is not valid; the
    recorder counts it as skipped and carries on."""
    from ledger import homes, sessions  # imported here: the hook half of this file must stay fast

    sid, event, at = line.get("session_id"), line.get("offer_event"), line.get("at")
    trigger, key = line.get("offer_trigger"), line.get("ticket_key")
    if not isinstance(sid, str) or not spool.SESSION_ID.match(sid):
        raise ValueError("bad session id")
    if event not in OFFER_EVENTS:
        raise ValueError("bad offer event")
    if not isinstance(at, str) or not STAMP.match(at):
        raise ValueError("bad time")
    if event == "offered" and trigger not in TRIGGERS:
        raise ValueError("an offer needs its trigger")
    if event != "offered":
        trigger = None
    if event == "accepted" and not (isinstance(key, str) and TICKET_KEY.match(key) and len(key) <= 20):
        raise ValueError("an accepted offer needs its ticket key")
    if event != "accepted":
        key = None
    uid = sessions.ensure(conn, tool="claude-code", tool_session_id=sid, started_at=at, started_by="unknown", now=now,
                          by=by)
    if conn.execute("SELECT 1 FROM ticket_offers WHERE session_uid = ? AND event = ? AND at = ? "
                    "AND COALESCE(ticket_key, '') = COALESCE(?, '')", (uid, event, at, key)).fetchone():
        return 0
    conn.execute("INSERT INTO ticket_offers (session_uid, event, offer_trigger, ticket_key, at, recorded_by) "
                 "VALUES (?, ?, ?, ?, ?, ?)", (uid, event, trigger, key, at, by))
    if event == "accepted":
        tracker = homes._tracker_for(key, registry)
        if tracker is not None and not conn.execute(
                "SELECT 1 FROM ticket_links WHERE session_uid = ? AND ticket_key = ? AND source = 'offer'",
                (uid, key)).fetchone():
            conn.execute("INSERT INTO ticket_links (session_uid, tracker, ticket_key, relation, source, linked_at, "
                         "recorded_by) VALUES (?, ?, ?, 'touched', 'offer', ?, ?)", (uid, tracker, key, at, by))
    return 1


if __name__ == "__main__":
    sys.exit(main())
