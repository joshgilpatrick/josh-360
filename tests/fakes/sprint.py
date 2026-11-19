#!/usr/bin/env python3
"""A fake `sprint.py` for the JP-175 tests: only `handoff`. It reads the made-up sprint state the way the real one
does (the sprint's lead must be live in the fake Agent Manager) and logs each handoff to $FAKE_AM_DIR/handoffs.jsonl.
Nothing real: no Jira, no Agent Manager."""
import json
import os
import sqlite3
import sys

args = sys.argv[1:]
if not args or args[0] != "handoff":
    sys.stderr.write("fake sprint.py: only handoff\n")
    sys.exit(2)
key = args[1]
opts = {args[i][2:]: args[i + 1] for i in range(2, len(args) - 1) if args[i].startswith("--") and args[i] != "--json"}
sprint = json.load(open(os.path.join(os.environ["SPRINT_STATE_ROOT"], opts["sprint"], "sprint.json")))
conn = sqlite3.connect(os.path.join(os.environ["FAKE_AM_DIR"], "state.db"))
row = conn.execute("SELECT status FROM sessions WHERE id = ?", (sprint["lead_session_id"],)).fetchone()
if row is None or row[0] == "dead":
    sys.stderr.write("no live lead for {}; start one with /sprint\n".format(opts["sprint"]))
    sys.exit(2)
with open(os.path.join(os.environ["FAKE_AM_DIR"], "handoffs.jsonl"), "a") as out:
    out.write(json.dumps({"to": sprint["lead_session_id"], "key": key, "note": opts.get("note"),
                          "text": "[sprint] new ticket {}: {}. Route it (lead.md, Epics).".format(key, opts.get("note"))}) + "\n")
print(json.dumps({"message_id": 1}))
