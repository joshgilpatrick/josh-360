"""What the doctor cannot see by itself (JP-152): the "laptop checks owed" collected from the proof READMEs under
docs/proof/, each with the ticket it came from and the steps to do it. They are listed after the checks, never
counted as passes or failures. A check that can show the same thing from evidence in the ledger sits beside them
(the `evidence` group), so a manual step already seen shows green there."""
from __future__ import annotations

import datetime
import json
import sys
from typing import Dict, List

sys.dont_write_bytecode = True
from .core import PASS, SKIP, WARN, Ctx, Result, check  # noqa: E402

DEBRIEF_DUE = datetime.date(2026, 12, 1)

MANUAL: List[Dict[str, str]] = [
    {"id": "ticket-offer", "ticket": "JP-110",
     "what": "A session at its first commit with no ticket is offered one, once, and the commit still goes ahead.",
     "how": "In a throwaway folder with no ticket, start a Claude Code session, ask it to create a file and make a commit. "
            "Its next message should say \"This has become ticket-sized work, want me to open a ticket?\". "
            "Then evidence.ticket-offer turns green after the recorder's next pass."},
    {"id": "ticket-comments", "ticket": "JP-118",
     "what": "A new Jira comment reaches the session working on that ticket.",
     "how": "Start a session on a branch named after a made-up test ticket, then comment on that ticket in Jira. "
            "Within about 10 minutes the session's next tool call should show the comment under "
            "\"Josh 360: new comment(s) on a ticket you are working on\". Then evidence.ticket-comments turns green."},
    {"id": "removal-guard", "ticket": "JP-111",
     "what": "Session Atlas's guard blocks a worktree removal that would lose work.",
     "how": "In a Claude Code session run `git worktree remove --force /tmp/x`. It should be blocked with a reason."},
    {"id": "atlas-macos-gates", "ticket": "JP-111",
     "what": "The moved Atlas behaves on macOS: the FSEvents burst, Finder and foreground-responsiveness gates claude-360 listed.",
     "how": "Use the laptop normally for a day with Atlas running and watch for slowness; "
            "`npm run artifacts -- status` in ~/.josh-360/repo/apps/session-atlas shows the first scan's progress."},
    {"id": "closeout", "ticket": "JP-109",
     "what": "The loose-ends list is real and the closeout agent's first run is sensible.",
     "how": "python3 ~/.josh-360/repo/ledger/loose_ends.py --fetch (long at first, about 1,000 before the ledger); "
            "then /closeout in a Claude Code session and watch the `by: josh` items it asks about."},
    {"id": "jira-flag", "ticket": "JP-121",
     "what": "The shared Jira library can set and clear the Flagged field on a real ticket.",
     "how": "python3 ~/.josh-360/repo/graphs/gates/set-flag.py --ticket JP-121 --on, then the same with --off."},
    {"id": "intake-run", "ticket": "JP-121",
     "what": "A made-up to-do runs through the ticket creation graph to a real Jira ticket, then is cancelled.",
     "how": "python3 ~/.josh-360/repo/graphs/intake/submit.py --source todo --ref <id> against the JP space, "
            "approve the card in the Needs you tab, confirm the ticket in Jira, then cancel it."},
    {"id": "laptop-tests", "ticket": "JP-105",
     "what": "The laptop tests pass on the Mac's own Python 3.9.",
     "how": "cd ~/.josh-360/repo/tests && /usr/bin/python3 -B -m unittest test_install test_follow test_hooks (ends with OK)."},
]


@check("owed", "debrief-form")
def debrief_form(ctx: Ctx) -> Result:
    cid = "owed.debrief-form"
    try:
        form = json.loads((ctx.copy / "ledger" / "debrief_form.json").read_text(encoding="utf-8"))
        status = form.get("status")
    except (OSError, ValueError, AttributeError):
        return Result(cid, SKIP, "ledger/debrief_form.json cannot be read")
    if status != "provisional":
        return Result(cid, PASS, "the debrief form is final (JP-113)")
    if ctx.now.date() < DEBRIEF_DUE:
        return Result(cid, SKIP, "the debrief form is provisional; finalise it on or after {} (two weeks of friction rows, JP-113)".format(
            DEBRIEF_DUE.isoformat()))
    return Result(cid, WARN, "the debrief form is still provisional and its two weeks of rows are in (JP-113)",
                  "python3 ~/.josh-360/repo/ledger/debrief.py status; then finalise-form and commit ledger/debrief_form.json")
