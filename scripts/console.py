#!/usr/bin/env python3
"""The Josh 360 console (JP-185): everything Josh 360 is doing, live, in one colored stream.

It follows, read-only, what Josh 360 already writes under JOSH360_HOME (default ~/.josh-360):

- the ledger's graph tables: runs and steps starting and ending, gate notes, run ends, questions for Josh, comments
  passed on (source `graph` / `ledger`);
- logs/runner/runner.log and every logs/runner/run-<id>.log (`runner`, `advance`);
- every job log in logs/ (`job`): each `=== <time> exit <n>` is one line, with up to four output lines under it;
- logs/hooks.log (`hooks`): hook blocks and failures;
- the hook spool in state/ledger-spool/ (`session`): sessions starting and ending.

Red is an error or a failed exit, yellow a stop or an abandon, the NEEDS JOSH badge a question or a run that ended
needing Josh, cyan a start, green a clean end, dim the routine. Ticket keys are underlined blue.

    python3 scripts/console.py                 follow from 30 minutes ago (Ctrl-C stops it)
    python3 scripts/console.py --since 2h      start further back (m, h, d; or "all")
    python3 scripts/console.py --once          print what is there and exit (tests, cloud runs)
    python3 scripts/console.py --source graph --source hooks   only those sources
    python3 scripts/console.py --no-color      plain text (also when NO_COLOR is set or the output is a pipe)

The `console-terminal` job runs it with `--heartbeat --name console` in an Agent Manager terminal. It shows only
what those files already hold, and writes nothing but its own heartbeat. Python 3.9, standard library only.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import time
from pathlib import Path
from typing import Dict, List, Optional

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent.parent
for _p in (str(ROOT), str(ROOT / "scripts")):
    if _p not in sys.path:
        sys.path.insert(0, _p)
from laptop import common  # noqa: E402
from console_lib import am, render, sources  # noqa: E402
from console_lib import events as ev  # noqa: E402

HEARTBEAT_SECONDS = 30
SINCE = re.compile(r"^(\d+)([mhd])$")


def heartbeat_path(home: Path) -> Path:
    return home / "state" / "console-heartbeat.json"


def parse_since(text: str, now: float) -> Optional[str]:
    if text == "all":
        return None
    found = SINCE.match(text)
    if not found:
        raise argparse.ArgumentTypeError("--since takes a number and m, h or d (30m, 2h, 1d), or all")
    seconds = int(found.group(1)) * {"m": 60, "h": 3600, "d": 86400}[found.group(2)]
    return ev.iso_from_epoch(now - seconds)


class Console:
    """Every source under one home. `poll()` returns the new events of all of them, in time order."""

    def __init__(self, home: Path, since: Optional[str], only: Optional[List[str]] = None) -> None:
        self.home, self.since, self.only = home, since, set(only or [])
        self.ledger = sources.LedgerSource(sources.home_paths(home)["ledger"], since or "0000")
        self.tails: Dict[Path, sources.LogTail] = {}
        self.first = True

    def missing(self) -> List[str]:
        paths = sources.home_paths(self.home)
        named = [("ledger", paths["ledger"].is_file()), ("runner log", (paths["runner"] / "runner.log").is_file()),
                 ("hooks log", (paths["logs"] / "hooks.log").is_file()),
                 ("job logs", any(p.name != "hooks.log" for p in paths["logs"].glob("*.log"))),
                 ("hook spool", any(paths["spool"].glob("*.jsonl")))]
        return [name for name, there in named if not there]

    def poll(self) -> List[ev.Event]:
        found: List[ev.Event] = []
        try:
            found.extend(self.ledger.poll())
        except Exception:  # noqa: BLE001  (a damaged ledger costs its lines, never the console)
            pass
        for path, source, parser, stamped in sources.log_files(self.home):
            tail = self.tails.get(path)
            new_file = tail is None
            if new_file:
                tail = self.tails[path] = sources.LogTail(path, source, parser, stamped)
            try:
                found.extend(tail.poll(self.since, first=self.first))
            except Exception:  # noqa: BLE001
                continue
        self.first = False
        found = [e._replace(order=i) for i, e in enumerate(found)]   # read order breaks ties: a file's lines stay together
        if self.only:
            found = [e for e in found if e.source in self.only]
        tickets = self.ledger.run_tickets
        found = [e._replace(ticket=e.ticket or tickets.get(e.run or "")) for e in found]
        rank = {name: i for i, name in enumerate(sources.SOURCES)}
        return sorted(found, key=lambda e: (e.at, rank.get(e.source, 99), e.order))


def use_color(args: argparse.Namespace, stream) -> bool:
    if args.no_color or os.environ.get("NO_COLOR"):
        return False
    return bool(args.color or (hasattr(stream, "isatty") and stream.isatty()))


def say(out, text: str, color: bool) -> None:
    out.write(render.line(ev.make(None, "console", "quiet", text), color) + "\n")


def write_heartbeat(home: Path) -> None:
    try:
        lane = common.Lane(home)
        lane.mkdir(heartbeat_path(home).parent)
        lane.write_text(heartbeat_path(home), json.dumps({"pid": os.getpid(), "at": ev.now_iso()}) + "\n")
    except (OSError, common.Unexpected):
        pass


def main(argv: Optional[List[str]] = None, out=None, now=time.time, sleep=time.sleep, polls: Optional[int] = None) -> int:
    out = out or sys.stdout
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--since", default="30m")
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--no-color", action="store_true")
    parser.add_argument("--color", action="store_true", help="color even when the output is not a terminal")
    parser.add_argument("--source", action="append", choices=sources.SOURCES)
    parser.add_argument("--poll", type=float, default=1.0, help="seconds between reads (default 1)")
    parser.add_argument("--heartbeat", action="store_true", help="write state/console-heartbeat.json for the job")
    parser.add_argument("--name", help="name this Agent Manager terminal (and the window title)")
    args = parser.parse_args(argv)
    try:
        since = parse_since(args.since, now())
    except argparse.ArgumentTypeError as err:
        parser.error(str(err))
    color = use_color(args, out)
    home = common.home()
    console = Console(home, since, args.source)

    named = ""
    if args.name:
        if color:
            out.write("\033]2;{}\007".format(args.name))          # the window and tmux pane title
        named = " · " + am.rename(args.name)
    if not args.once:
        say(out, "Josh 360 console · {} · from {}{} · Ctrl-C stops".format(
            home, render.local_time(since) if since else "the start", named), color)
    gone = console.missing()
    if gone:
        say(out, "not there yet: {} (shown once they appear)".format(", ".join(gone)), color)
    width = None
    beat = 0.0
    count = 0
    try:
        while True:
            if not args.once:
                width = shutil.get_terminal_size((160, 40)).columns if hasattr(out, "isatty") and out.isatty() else None
            for event in console.poll():
                out.write(render.line(event, color, width) + "\n")
            out.flush()
            count += 1
            if args.once or (polls is not None and count >= polls):
                return 0
            if args.heartbeat and now() - beat >= HEARTBEAT_SECONDS:
                write_heartbeat(home)
                beat = now()
            sleep(args.poll)
    except KeyboardInterrupt:
        return 0
    except BrokenPipeError:
        return 0


if __name__ == "__main__":
    sys.exit(main())
