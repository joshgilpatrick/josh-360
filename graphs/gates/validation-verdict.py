#!/usr/bin/env python3
"""Gate validation-verdict (JP-167): add up the section and the watch into one answer. Read-only, no model.

It decides from `needed` first, because the walker still holds last round's `watch_result` when this round's `watch`
did not run (the section now says no, or cannot be read). Only for `yes` does it read `watch_result`.

Outcomes: met, not_needed (Needed: no, or no section), not_met, undecided (the section cannot be read, the watch ended
with no data, or every scripted criterion is met and a @manual one is left for Josh).
Inputs: ticket_key, needed, problems, criteria, watch_result, tally.
Outputs: result, evidence (the table the closing comment shows: counts and links only), failed (the tally entries of the
criteria that were not met), card (the path of the card file when undecided, else empty). Whenever it answers
undecided it rewrites the one card file under the run's `work/watch/`.
"""
import json
from pathlib import Path

from lib import validation_copy as copy, validation_section
from lib.gate_run import GateError, execute, need
from lib.ticket_text import as_list
from lib.triage.ticket import description_text
from lib.watch import history, round as watch_round

NEVER_BEGAN = ("starts_cancelled", "starts_missing", "never_began")


def _list(inputs, name):
    try:
        return as_list(inputs.get(name))
    except ValueError:
        raise GateError("the input '{}' is not a list".format(name))


def _newest(deps):
    """(the newest round's watch file as a dict, its `end` line or {}). Empty when there is no round yet."""
    path = watch_round.newest(Path(deps.work_dir) / "watch")
    if path is None:
        return {}, {}
    try:
        plan = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        plan = {}
    return (plan if isinstance(plan, dict) else {}), (watch_round.ended(path) or {})


def _undecided(deps, text, evidence, summary):
    return "undecided", {"result": "undecided", "evidence": evidence, "failed": [],
                         "card": copy.write_card(deps.work_dir, text)}, summary


def _not_needed(key, deps):
    issue = deps.jira.get(key)
    if issue is None:
        raise GateError("{} could not be read from Jira".format(key))
    section = validation_section.parse(description_text((issue.get("fields") or {}).get("description")), key)
    why = copy.says_no(section["reason"]) if section["present"] else copy.no_section()
    return "not_needed", {"result": "not_needed", "evidence": why, "failed": [], "card": ""}, "nothing to watch"


def _unmeasured(criteria, tally):
    """Names of the measured criteria that no check could read."""
    counts = {t.get("id"): t for t in tally if isinstance(t, dict)}
    return [c.get("name") or c.get("id") for c in criteria
            if not c.get("manual") and not (counts.get(c.get("id")) or {}).get("passed")
            and not (counts.get(c.get("id")) or {}).get("failed")]


def run(inputs, deps):
    key = need(inputs, "ticket_key")
    needed = (inputs.get("needed") or "").strip()
    criteria, tally, problems = _list(inputs, "criteria"), _list(inputs, "tally"), _list(inputs, "problems")
    if needed == "no":
        return _not_needed(key, deps)
    if needed != "yes":
        return _undecided(deps, copy.card("unreadable", key=key, problems=problems), "",
                          "the Validation section cannot be read")
    result = need(inputs, "watch_result")
    evidence = copy.evidence_table(criteria, tally)
    if result == "met":
        return "met", {"result": "met", "evidence": evidence, "failed": [], "card": ""}, "the criteria were met"
    if result == "not_met":
        failed = history.failing(tally)
        return "not_met", {"result": "not_met", "evidence": evidence, "failed": failed, "card": ""}, \
            "{} criterion(s) not met".format(len(failed))
    if result == "needs_josh":
        statements = [c.get("statement") for c in criteria if c.get("manual")]
        return _undecided(deps, copy.card("manual", key=key, statements=statements), evidence,
                          "measured criteria met; {} left for Josh".format(len(statements)))
    if result == "no_data":
        plan, end = _newest(deps)
        reason = str(end.get("reason") or "")
        if reason in NEVER_BEGAN:
            text = copy.card("never_began", key=key, starts=plan.get("starts") or "", reason=reason)
            return _undecided(deps, text, evidence, "the watch never began")
        text = copy.card("no_readings", key=key, names=_unmeasured(criteria, tally))
        return _undecided(deps, text, evidence, "no readings by the give-up time")
    raise GateError("the watch ended '{}', which the verdict does not know".format(result[:40]))


if __name__ == "__main__":
    execute(run, ["ticket_key", "needed", "problems", "criteria", "watch_result", "tally"])
