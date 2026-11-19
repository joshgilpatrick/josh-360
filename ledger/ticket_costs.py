"""What a ticket's sessions cost, step by step (JP-170). Python 3.9, standard library only.

Read-only, for Josh: it is reached only through `ledger/measures.py ticket <KEY>`. Working agents never see cost
(`ledger/ask.py` cannot return it), so nothing in here is imported by `ask.py`.

One row per graph step attempt that had a session, in start order, then one row per session homed to the ticket that
did no step in any run. A subagent's cost is folded into the session that started it (the views `session_subagent_roots`
and `session_costs_rolled_up`, migration 0002) and a subagent is never a row of its own. A session that did several
step attempts shows its cost on the first row only, so the total counts it once. A session with no priced cost yet
says "not priced yet" in place of a cost, and the total line says how many there are.
"""
from __future__ import annotations

import re
import sqlite3
from typing import List, Optional

KEY = re.compile(r"^[A-Z][A-Z0-9]*-[0-9]+$")
NOT_A_STEP = "not a graph step"

_FIELDS = ("own_cost_usd", "subagent_cost_usd", "cost_usd", "own_pricing_status", "subagents",
           "subagents_not_fully_priced", "subagents_unpriced")

STEPS_SQL = """
SELECT c.graph_id, c.step, c.attempt, c.model, x.tool_session_id, c.session_uid,
       c.own_cost_usd, c.subagent_cost_usd, c.cost_usd, c.own_pricing_status, c.subagents,
       c.subagents_not_fully_priced, c.subagents_unpriced
FROM step_costs_rolled_up c JOIN sessions x ON x.session_uid = c.session_uid
WHERE c.ticket = ? AND c.session_uid IS NOT NULL
ORDER BY c.started_at, c.step, c.attempt, c.loop_count"""

# Homed to the ticket, did no step in any run (a step session shows under its run's ticket only), and not a subagent
# (a subagent's cost is inside the session that started it, whatever ticket the subagent itself is homed to).
OTHERS_SQL = """
SELECT NULL, NULL, NULL, NULL, x.tool_session_id, x.session_uid,
       c.own_cost_usd, c.subagent_cost_usd, c.cost_usd, c.own_pricing_status, c.subagents,
       c.subagents_not_fully_priced, c.subagents_unpriced
FROM current_homes h JOIN sessions x ON x.session_uid = h.session_uid
LEFT JOIN session_costs_rolled_up c ON c.session_uid = x.session_uid
WHERE h.ticket_key = ?
  AND x.session_uid NOT IN (SELECT session FROM step_ledger WHERE session IS NOT NULL)
  AND x.session_uid NOT IN (SELECT session_uid FROM session_subagent_roots)
ORDER BY x.started_at, x.session_uid"""


def check_key(key: Optional[str]) -> str:
    if not key or not KEY.match(key):
        raise ValueError("{!r} is not a ticket key (for example JP-170)".format(key))
    return key


def pricing(own_status: Optional[str], subagents: int, unpriced: int, not_fully_priced: int) -> str:
    """priced, partly-priced or unpriced for a row: its own cost and its subagents' together."""
    if own_status == "priced" and not_fully_priced == 0:
        return "priced"
    if own_status in (None, "unpriced") and unpriced == subagents:
        return "unpriced"
    return "partly-priced"


def cost_fields(parts: tuple) -> dict:
    """{"cost_usd", "cost_pricing"} for one step from the view's columns (own, subagent, total, own status, subagents,
    not fully priced, unpriced), as the run report shows them."""
    own, sub, total, own_status, subagents, not_full, unpriced = parts
    status = pricing(own_status, subagents or 0, unpriced or 0, not_full or 0)
    return {"cost_usd": None if status == "unpriced" else _money(total), "cost_pricing": status}


def cost_text(total: Optional[float], status: str) -> str:
    """One cost as a cell: "$4.00", "$4.00 (partly priced)" or "not priced yet"."""
    if status == "unpriced":
        return "not priced yet"
    return _usd(total) + (" (partly priced)" if status == "partly-priced" else "")


def _money(value: Optional[float]) -> Optional[float]:
    return None if value is None else round(value, 4)


def _row(raw: tuple) -> dict:
    graph, step, attempt, model, session, uid = raw[:6]
    own, sub, total, own_status, subagents, not_full, unpriced = raw[6:]
    subagents, not_full, unpriced = subagents or 0, not_full or 0, unpriced or 0
    status = pricing(own_status, subagents, unpriced, not_full)
    return {"graph": graph, "step": step, "attempt": attempt, "model": model, "session": session, "uid": uid,
            "own_usd": _money(own), "subagents": subagents,
            "subagents_usd": _money(sub) if subagents and sub is not None else (0.0 if not subagents else None),
            "total_usd": None if status == "unpriced" else _money(total), "pricing": status, "same_session_as": None}


def ticket_report(conn: sqlite3.Connection, key: str) -> dict:
    check_key(key)
    rows: List[dict] = []
    first_row = {}
    for raw in conn.execute(STEPS_SQL, (key,)).fetchall() + conn.execute(OTHERS_SQL, (key,)).fetchall():
        row = _row(raw)
        if row["uid"] in first_row:      # the same session did another attempt: its cost is already on the first row
            row.update(own_usd=None, subagents_usd=None, total_usd=None, subagents=0, pricing="same-session",
                       same_session_as=first_row[row["uid"]])
        else:
            first_row[row["uid"]] = "{} #{}".format(row["step"], row["attempt"]) if row["step"] else NOT_A_STEP
        rows.append(row)
    counted = [r for r in rows if r["same_session_as"] is None]
    for r in rows:
        r.pop("uid")
    return {"ticket": key, "rows": rows, "sessions": len(counted),
            "total_usd": round(sum(r["total_usd"] or 0.0 for r in counted), 4),
            "not_priced": sum(1 for r in counted if r["pricing"] == "unpriced"),
            "partly_priced": sum(1 for r in counted if r["pricing"] == "partly-priced")}


# -- the text table ------------------------------------------------------------------------------------------------

def _usd(value: Optional[float]) -> str:
    return "-" if value is None else "${:.2f}".format(value)


def _total_cell(row: dict) -> str:
    if row["same_session_as"]:
        return "same session as " + row["same_session_as"]
    return cost_text(row["total_usd"], row["pricing"])


def _plural(n: int, word: str) -> str:
    return "{} {}{}".format(n, word, "" if n == 1 else "s")


def render(report: dict) -> str:
    if not report["rows"]:
        return "No sessions recorded for {}\n".format(report["ticket"])
    head = ("Graph", "Step", "Try", "Model", "Session", "Own", "Subagents", "Total")
    body = [(r["graph"] or "", r["step"] or NOT_A_STEP, "" if r["attempt"] is None else str(r["attempt"]),
             r["model"] or "", r["session"], "" if r["same_session_as"] else _usd(r["own_usd"]),
             "" if r["same_session_as"] or not r["subagents"] else _usd(r["subagents_usd"]), _total_cell(r))
            for r in report["rows"]]
    widths = [max(len(line[i]) for line in [head] + body) for i in range(len(head))]
    lines = ["{}: what its sessions cost".format(report["ticket"]), ""]
    for line in [head] + body:
        lines.append("  ".join(cell.ljust(widths[i]) for i, cell in enumerate(line)).rstrip())
    total = "Total: {} for {}".format(_usd(report["total_usd"]), _plural(report["sessions"], "session"))
    if report["not_priced"]:
        total += ", {} not priced yet".format(_plural(report["not_priced"], "session"))
    if report["partly_priced"]:
        total += ", {} partly priced".format(report["partly_priced"])
    return "\n".join(lines + ["", total]) + "\n"
