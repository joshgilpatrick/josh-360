#!/usr/bin/env python3
"""Gate return-to-triage (JP-104 design, shared with JP-103 and JP-115; built in JP-123): hand a ticket back to triage.

Moves the JP ticket to Not Started, sets the flag, and comments the reason in the workflow's shape so triage takes it
again with reason `returned`. It counts nothing: triage counts returns (spec rule 17). A ticket outside JP is left
untouched, because it belongs to colleagues too and this graph never writes there. The reason is a fixed sentence from
read-ticket, or "the work needs code changes" when the researcher ended `needs_code`; no free text from the ticket.

With a `card` (the development graph's designer asked a question) the card is saved to question.md in the run's work
folder, the comment is the designer's-question copy (the question itself only when `phi` is false and the screen passes
it, else the path), and the worktree is removed when nothing in it is at risk: one with commits or uncommitted files
stays for the resumed run. Without a `card` it behaves exactly as before.

Outcomes: returned. Inputs: ticket_key, reason, card, worktree, work_dir, phi.
"""
import re
from pathlib import Path

from lib import dev_copy, dev_git
from lib.gate_run import GateError, execute, need, say, screened
from lib.nondev_copy import returned
from lib.ticket_text import as_bool, collapse, shorten

DEFAULT_REASON = "the work needs code changes, see the researcher's last comment"
QUESTION_LIMIT = 400


def _check_work_folder(raw, worktree, deps):
    work = Path(raw).expanduser().resolve()
    if work != Path(deps.work_dir).expanduser().resolve():
        raise GateError("work_dir is not this run's work folder")
    if ".claude/worktrees" in work.as_posix() or (worktree and work == worktree) or (worktree and worktree in work.parents):
        raise GateError("the work folder is inside the worktree")
    return work


def _return_with_card(key, inputs, deps):
    worktree_raw = (inputs.get("worktree") or "").strip()
    worktree = Path(worktree_raw).expanduser().resolve() if worktree_raw else None
    work = _check_work_folder(need(inputs, "work_dir"), worktree, deps)
    card = need(inputs, "card")
    work.mkdir(parents=True, exist_ok=True)
    (work / "question.md").write_text(card, encoding="utf-8")
    path = str(work / "question.md")
    comment = dev_copy.returned_question(None, path, deps.run_id)
    if not as_bool(inputs.get("phi"), True):
        try:
            comment = screened(dev_copy.returned_question(shorten(card, QUESTION_LIMIT), path, deps.run_id))
        except GateError:
            pass   # the screen found something: the path goes instead of the question
    deps.ticket.move(key, "Not Started")
    deps.ticket.set_flag(key, True)
    say(deps.ticket, key, comment, once=True)
    kept = "no worktree to remove"
    if worktree is not None:
        try:
            clone = dev_git.clone_of(worktree)
            branch = worktree.name
            if worktree.exists():
                branch = dev_git.git(worktree, "branch", "--show-current") or worktree.name
            reason = dev_git.remove_worktree(clone, worktree, branch)
        except dev_git.GitError as exc:
            reason = "git said: {}".format(str(exc)[:80])
        kept = "worktree removed" if reason is None else "worktree kept ({})".format(reason)
    return "returned", None, "returned to triage with the designer's question; {}".format(kept)


def run(inputs, deps):
    key = need(inputs, "ticket_key")
    if not re.match(r"^JP-\d+$", key):
        return "returned", None, "not a JP ticket: left unchanged"
    if (inputs.get("card") or "").strip():
        return _return_with_card(key, inputs, deps)
    reason = (inputs.get("reason") or "").strip() or DEFAULT_REASON
    deps.ticket.move(key, "Not Started")
    deps.ticket.set_flag(key, True)
    say(deps.ticket, key, returned(reason), once=True)
    return "returned", None, "returned to triage"


if __name__ == "__main__":
    execute(run, ["ticket_key", "reason", "card", "worktree", "work_dir", "phi"])
