"""The run folder: what a run keeps outside the ledger. Standard library only.

$JOSH360_RUNS/<run id>/ (default ~/.josh-360/runs/<run id>/) holds run.json (the run's input values, the output values
of its steps, whether it is stopped, grants waiting to be used, the Jira status last set, whether the flag is on),
results/ (where a role session writes its outcome), outputs/ and saved/ (the files kept at the end of a run).
It is outside the repository on purpose: the spec and the evidence must outlive the worktree.
"""
from __future__ import annotations

import hashlib
import json
import os
import secrets
import shutil
from pathlib import Path
from typing import Dict, List, Optional

from laptop import common

SAVED_KINDS = {"spec": "spec", "plan": "plan", "evidence": "evidence", "feedback": "feedback",
               "deliverable": "deliverable"}


def runs_dir() -> Path:
    return Path(os.environ.get("JOSH360_RUNS") or str(common.home() / "runs")).absolute()


def new_run_id() -> str:
    return "r-" + secrets.token_hex(6)


def folder(run_id: str) -> Path:
    if not run_id.startswith("r-") or not run_id[2:].isalnum():
        raise ValueError("not a run id: {}".format(run_id))
    return runs_dir() / run_id


def _write(path: Path, doc: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(doc, indent=1, sort_keys=True), encoding="utf-8")
    os.replace(str(tmp), str(path))


def create(run_id: str, doc: dict) -> None:
    base = folder(run_id)
    for sub in ("results", "outputs", "saved"):
        (base / sub).mkdir(parents=True, exist_ok=True)
    _write(base / "run.json", doc)


def load(run_id: str) -> dict:
    path = folder(run_id) / "run.json"
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise FileNotFoundError("run {} has no run folder at {}; its input values are gone, so it cannot go on".format(
            run_id, path.parent))


def save(run_id: str, doc: dict) -> None:
    _write(folder(run_id) / "run.json", doc)


def result_file(run_id: str, step: str, attempt: int) -> Path:
    return folder(run_id) / "results" / "{}-{}.json".format(step, attempt)


def read_result(path: Path) -> Dict[str, object]:
    try:
        doc = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise ValueError("the result file {} is missing or is not JSON".format(path))
    if not isinstance(doc, dict) or not isinstance(doc.get("outcome"), str):
        raise ValueError('the result file must be a JSON object with an "outcome"')
    outputs = doc.get("outputs") or {}
    if not isinstance(outputs, dict):
        raise ValueError('"outputs" in the result file must be an object')
    return {"outcome": doc["outcome"], "outputs": outputs}


def values(doc: dict) -> Dict[str, object]:
    """Input values, then step outputs (a later output of the same name wins)."""
    merged = dict(doc.get("inputs", {}))
    for outputs in doc.get("outputs", {}).values():
        merged.update(outputs)
    return merged


def save_outputs(doc: dict, step: str, outputs: Dict[str, object]) -> None:
    doc.setdefault("outputs", {})[step] = outputs


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def is_saved_file(value: object) -> bool:
    """True when a step output names an existing file. Any other text (a card, a question, a list of problems) is
    not a path and must never be asked about as one: the operating system refuses a long or multi-line name with an
    error, and that error once stopped a run from ending."""
    if not isinstance(value, str) or not value or len(value) > 1024 or "\n" in value or "\x00" in value:
        return False
    try:
        return Path(value).is_file()
    except (OSError, ValueError):
        return False


def files_to_save(graph, doc: dict) -> List[dict]:
    """Step outputs that name an existing file, with the kind their contract gives them."""
    found = []
    for step in graph.order:
        declared = graph.steps[step].get("outputs") or {}
        for name, value in (doc.get("outputs", {}).get(step) or {}).items():
            if not is_saved_file(value):
                continue
            contract = (declared.get(name) or {}).get("contract")
            found.append({"step": step, "name": name, "path": value, "kind": SAVED_KINDS.get(contract, "output")})
    return found


def save_files(run_id: str, items: List[dict]) -> List[dict]:
    """Copy each file into the run's saved/ folder. Returns the items with the new path and hash."""
    saved = []
    for i, item in enumerate(items):
        target = folder(run_id) / "saved" / "{:02d}-{}-{}{}".format(i, item["step"], item["name"],
                                                                    Path(item["path"]).suffix)
        shutil.copyfile(item["path"], str(target))
        saved.append(dict(item, path=str(target), sha256=sha256_file(target)))
    return saved
