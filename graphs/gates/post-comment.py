#!/usr/bin/env python3
"""Effect: post-comment. Used by the walker (JP-114), not named by any graph step.

    post-comment.py --ticket KEY --body-file FILE

Posts the file's text as a comment on the ticket (the walker posts Josh's typed answer this way). The shared Jira
library runs the patient-data screen for outside writes first and refuses the post on a problem, so a refusal here
is the screen working. Exit 0 only when the comment reads back; any other result exits 1 and the walker treats it
as a warning. Built on the shared Jira library (graphs/gates/lib/jira.py, JP-121).
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from lib.gate_io import fail  # noqa: E402
from lib.jira import Jira, JiraError  # noqa: E402


def main(argv=None, jira=None):
    parser = argparse.ArgumentParser(description="Post a file's text as a comment on a ticket.")
    parser.add_argument("--ticket", required=True)
    parser.add_argument("--body-file", required=True)
    args = parser.parse_args(argv)
    try:
        text = Path(args.body_file).read_text(encoding="utf-8")
    except OSError as err:
        fail(f"post-comment: cannot read the body file ({err.strerror or err})")
    if not text.strip():
        fail("post-comment: the body file is empty")
    jira = jira or Jira.from_env()
    try:
        confirmed = jira.comment(args.ticket, text)
    except JiraError as err:
        fail(f"post-comment: {err}")
    if not confirmed:
        fail(f"post-comment: Jira did not confirm the comment on {args.ticket}")
    print(f"commented on {args.ticket}")


if __name__ == "__main__":
    main()
