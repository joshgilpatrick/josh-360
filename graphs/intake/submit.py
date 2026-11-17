#!/usr/bin/env python3
"""The one way a loose request becomes a ticket-creation run (JP-121).

    python3 graphs/intake/submit.py --source email|todo|session|manual --ref <pointer> [--space KEY] [--parent KEY]

It starts one `ticket-creation` run through the walker and prints the run id. It passes a pointer only, never the
request's own words: the intake reader looks the item up itself. Sources and what a pointer is: graphs/intake/README.md.

Exit 0 when a run started; 2 when it did not (the reason is on stderr, one line). Python 3.9, standard library only.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import List, Optional

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent.parent.parent
WALKER = ROOT / "graphs" / "tools" / "walker.py"

SOURCES = ("email", "todo", "session", "manual")      # notion joins in the second wave
POINTER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:/@#=+-]{0,199}$")   # no spaces: a pointer, never a sentence
SPACE = re.compile(r"^[A-Z][A-Z0-9]{1,9}$")
TICKET = re.compile(r"^[A-Z][A-Z0-9]+-[1-9][0-9]*$")


class Refused(Exception):
    pass


def check(source: str, ref: str, space: Optional[str], parent: Optional[str]) -> None:
    if source not in SOURCES:
        raise Refused("source must be one of {}".format(", ".join(SOURCES)))
    if not POINTER.match(ref or ""):
        raise Refused("--ref must be a short pointer (an id, a path or a thread id), not text")
    if space and not SPACE.match(space):
        raise Refused("--space must be a Jira space key such as JP or AD")
    if parent and not TICKET.match(parent):
        raise Refused("--parent must be a ticket key such as JP-94")


def start(source: str, ref: str, space: Optional[str] = None, parent: Optional[str] = None,
          runner: str = "cli") -> str:
    """Start the run; returns its id. Raises Refused with the walker's own words when it will not start."""
    check(source, ref, space, parent)
    argv = [sys.executable, str(WALKER), "start", "--graph", "ticket-creation", "--subject-kind", "intake",
            "--subject-ref", "{}:{}".format(source, ref), "--runner", runner,
            "--input", "source=" + source, "--input", "source_ref=" + ref]
    if space:
        argv += ["--input", "named_space=" + space]
    if parent:
        argv += ["--input", "named_parent=" + parent]
    done = subprocess.run(argv, capture_output=True, text=True)
    lines = [ln for ln in done.stdout.splitlines() if ln.strip()]
    try:
        reply = json.loads(lines[-1]) if lines else {}
    except ValueError:
        reply = {}
    if done.returncode != 0 or not reply.get("run"):
        raise Refused(str(reply.get("error") or done.stderr.strip() or "the walker did not start a run"))
    return str(reply["run"])


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Start a ticket-creation run for one loose request.")
    parser.add_argument("--source", required=True, choices=SOURCES)
    parser.add_argument("--ref", required=True, help="a pointer to the item, never its text")
    parser.add_argument("--space", help="a Jira space Josh named outright")
    parser.add_argument("--parent", help="a ticket key Josh named outright")
    args = parser.parse_args(argv)
    try:
        print(start(args.source, args.ref, args.space, args.parent))
    except Refused as err:
        print("submit: {}".format(err), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
