#!/usr/bin/env python3
"""Effect: set-flag. Used by the walker (JP-114), not named by any graph step.

    set-flag.py --ticket KEY --on|--off

Puts the Jira flag on the ticket when a question for Josh is parked, and takes it off when he answers. Exit 0 only
when Jira confirms the change on read-back; any other result exits 1 and the walker treats it as a warning.
Built on the shared Jira library (graphs/gates/lib/jira.py, JP-121).
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from lib.gate_io import fail  # noqa: E402
from lib.jira import Jira, JiraError  # noqa: E402


def main(argv=None, jira=None):
    parser = argparse.ArgumentParser(description="Put the Jira flag on a ticket, or take it off.")
    parser.add_argument("--ticket", required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--on", action="store_true")
    mode.add_argument("--off", action="store_true")
    args = parser.parse_args(argv)
    jira = jira or Jira.from_env()
    try:
        confirmed = jira.set_flag(args.ticket, args.on)
    except JiraError as err:
        fail(f"set-flag: {err}")
    if not confirmed:
        fail(f"set-flag: Jira did not confirm the flag {'on' if args.on else 'off'} for {args.ticket}")
    print(f"flag {'on' if args.on else 'off'} {args.ticket}")


if __name__ == "__main__":
    main()
