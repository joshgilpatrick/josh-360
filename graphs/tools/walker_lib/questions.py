"""The Needs you question store, written the way action-triage reads it. Standard library only.

One JSON file per question in a `questions/` folder beside action-triage's state.json (ACTION_AGENT_STATE_PATH, else
~/Library/Application Support/action-agent/state.json; JOSH360_QUESTIONS_DIR overrides the folder). The record is the
shape of src/core/questionStore.ts: `runner: headless`, so the app never counts it as stale and never prunes it
while it is open, and a parked run has no session waiting. Writes are a temp file and a rename, as the app does.
"""
from __future__ import annotations

import datetime
import json
import os
from pathlib import Path
from typing import Dict, List, Optional

# A headless question has no deadline: the turn is paused, not polling. action-triage writes this value for it
# (src/core/askHookDecision.ts, HEADLESS_WAIT_UNTIL), and its answerFromUi refuses an answer once now >= waitUntil.
HEADLESS_WAIT_UNTIL = "9999-12-31T23:59:59.000Z"

ID_RE = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"


def questions_dir() -> Path:
    override = os.environ.get("JOSH360_QUESTIONS_DIR")
    if override:
        return Path(override)
    state = os.environ.get("ACTION_AGENT_STATE_PATH")
    if state:
        return Path(state).parent / "questions"
    return Path.home() / "Library" / "Application Support" / "action-agent" / "questions"


def question_id(run_id: str, step: str, attempt: int) -> str:
    qid = "walker-{}-{}-{}".format(run_id, step, attempt)
    if not qid or any(c not in ID_RE for c in qid) or len(qid) > 200:
        raise ValueError("cannot make a question id from {}".format(qid))
    return qid


def _write(path: Path, doc: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(doc, indent=2), encoding="utf-8")
    os.replace(str(tmp), str(path))


def _iso(now: str) -> str:
    return datetime.datetime.strptime(now, "%Y-%m-%dT%H:%M:%SZ").strftime("%Y-%m-%dT%H:%M:%S.000Z")


def create(qid: str, run_id: str, ticket_key: Optional[str], cwd: str, header: str, text: str, choices: List[str],
           now: str) -> None:
    """Add the question if it is not there yet (parking twice must not reset an answer)."""
    path = questions_dir() / (qid + ".json")
    if path.is_file():
        return
    asked = _iso(now)
    _write(path, {
        "id": qid, "sessionId": "walker-" + run_id, "toolUseId": qid, "runner": "headless", "cwd": cwd,
        "agentManagerSessionId": None, "ticketKey": ticket_key,
        "questions": [{"question": text, "header": header[:12], "multiSelect": False,
                       "options": [{"label": c} for c in choices]}],
        "askedAt": asked, "waitUntil": HEADLESS_WAIT_UNTIL, "state": "open"})


def read(qid: str) -> Optional[dict]:
    try:
        return json.loads((questions_dir() / (qid + ".json")).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def answer_of(record: dict) -> Optional[str]:
    """The answer text when the record is answered, else None."""
    if record.get("state") not in ("answered", "delivered"):
        return None
    answers = record.get("answers") or {}
    text = record["questions"][0]["question"]
    value = answers.get(text)
    if value is None and len(answers) == 1:
        value = next(iter(answers.values()))
    return value if isinstance(value, str) and value.strip() else None


def answer(qid: str, text: str, now: str) -> bool:
    """Record an answer the way the app does. False when the record is not open."""
    record = read(qid)
    if record is None or record.get("state") != "open":
        return False
    record["state"] = "answered"
    record["answers"] = {record["questions"][0]["question"]: text}
    record["answeredAt"] = _iso(now)
    _write(questions_dir() / (qid + ".json"), record)
    return True


def mark_delivered(qid: str, now: str) -> None:
    """Only an answered record moves to delivered, so an answer the app is writing is never overwritten."""
    record = read(qid)
    if record is None or record.get("state") != "answered":
        return
    record["state"] = "delivered"
    record["deliveredAt"] = _iso(now)
    _write(questions_dir() / (qid + ".json"), record)


def reopen(qid: str) -> None:
    """An answer that matches nothing is cleared, so the question can be answered again."""
    record = read(qid)
    if record is None or record.get("state") != "answered":
        return
    record["state"] = "open"
    record.pop("answers", None)
    record.pop("answeredAt", None)
    _write(questions_dir() / (qid + ".json"), record)
