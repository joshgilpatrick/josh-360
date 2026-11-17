#!/usr/bin/env python3
"""JP-111: keep Session Atlas (apps/session-atlas) running on the laptop, as an hourly JP-105 job.

    python3 scripts/atlas_service.py            make sure it is installed, loaded and on the latest code
    python3 scripts/atlas_service.py --dry-run  say what it would do, change nothing

Atlas is a headless service (no dashboard, no model call): the artifact manager, the hourly cost import and a
read-only mirror of the ledger's sessions, all writing ~/.josh-360/state/cache.db. The worktree removal guard asks it
about live sessions, so it has to stay up. The job runner is not a long-running process, so launchd owns the service:
this job writes `~/Library/LaunchAgents/com.josh360.session-atlas.plist` and loads it.

Each run:

  1. Does nothing (exit 0, result "waiting") until `retire-session-atlas` has succeeded, so the old Atlas and the
     new one never run together.
  2. Finds Node 22.18 or newer (JOSH360_NODE alone if set, else PATH, then Homebrew's two folders). Missing or too old: exit 1.
  3. Writes the plist when it differs (atomic), loads the service when it is not loaded, and restarts it
     (`kickstart -k`) when the plist or the apps/session-atlas code changed since the last run, because Node reads
     its modules only at start. The revision it started on is kept in ~/.josh-360/state/session-atlas-service.json.
  4. Checks the service is loaded afterwards.

It touches only this one label and its own plist. With no `launchctl` (not a Mac) it changes nothing and exits 0
("skipped"). Python 3.9, standard library only. Override the program with JOSH360_LAUNCHCTL for tests.
"""
from __future__ import annotations

import hashlib
import json
import os
import plistlib
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Dict, List, Optional, Tuple

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from laptop import common  # noqa: E402

LABEL = "com.josh360.session-atlas"
MIN_NODE = (22, 18)
NODE_CANDIDATES = ("/opt/homebrew/bin/node", "/usr/local/bin/node")


def launchctl() -> str:
    return os.environ.get("JOSH360_LAUNCHCTL", "launchctl")


def _run(args: List[str]) -> subprocess.CompletedProcess:
    return subprocess.run([launchctl()] + args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          universal_newlines=True, timeout=60)


def is_loaded(domain: str) -> bool:
    return _run(["print", "{}/{}".format(domain, LABEL)]).returncode == 0


def retired() -> bool:
    record = common.read_json(common.state_dir() / "jobs-state.json", {}).get("retire-session-atlas", {})
    return record.get("last_result") == 0


def node_version(node: str) -> Optional[Tuple[int, int]]:
    try:
        out = subprocess.run([node, "--version"], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             universal_newlines=True, timeout=20).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None
    m = re.match(r"^v(\d+)\.(\d+)", out)
    return (int(m.group(1)), int(m.group(2))) if m else None


def find_node() -> Tuple[Optional[str], Optional[Tuple[int, int]]]:
    seen = []
    pinned = os.environ.get("JOSH360_NODE")  # an explicit choice is the only one tried
    for cand in [pinned] if pinned else [shutil.which("node")] + list(NODE_CANDIDATES):
        if cand and cand not in seen and os.access(cand, os.X_OK):
            seen.append(cand)
            v = node_version(cand)
            if v and v >= MIN_NODE:
                return cand, v
    return None, None


def code_revision() -> str:
    r = common.git(["log", "-1", "--format=%H", "--", "apps/session-atlas"], common.REPO_ROOT, check=False)
    return r.stdout.strip() if r.returncode == 0 and r.stdout.strip() else "unknown"


def build_plist(node: str) -> bytes:
    app = common.REPO_ROOT / "apps" / "session-atlas"
    env = {
        "HOME": str(Path.home()),
        "PATH": ":".join(dict.fromkeys([str(Path(node).parent), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"])),
    }
    if os.environ.get("JOSH360_HOME"):
        env["JOSH360_HOME"] = os.environ["JOSH360_HOME"]
    logs = common.logs_dir()
    return plistlib.dumps({
        "Label": LABEL,
        "ProgramArguments": [node, "--disable-warning=ExperimentalWarning", str(app / "src" / "service" / "main.ts")],
        "WorkingDirectory": str(app),
        "EnvironmentVariables": env,
        "RunAtLoad": True,
        "KeepAlive": True,
        "ThrottleInterval": 5,
        "ProcessType": "Background",
        "StandardOutPath": str(logs / "session-atlas.out.log"),
        "StandardErrorPath": str(logs / "session-atlas.err.log"),
    })


def finish(report: Dict[str, object], code: int) -> int:
    print(json.dumps(report, indent=2, sort_keys=True))
    return code


def main(argv: List[str]) -> int:
    dry = "--dry-run" in argv
    domain = "gui/{}".format(os.getuid())
    plist_path = Path.home() / "Library" / "LaunchAgents" / (LABEL + ".plist")
    state_path = common.state_dir() / "session-atlas-service.json"
    report: Dict[str, object] = {"job": "session-atlas-service", "label": LABEL, "dry_run": dry, "actions": []}
    actions: List[str] = report["actions"]  # type: ignore[assignment]

    try:
        loaded = is_loaded(domain)
    except FileNotFoundError:
        report.update({"result": "skipped", "reason": "launchctl not found; not a Mac"})
        return finish(report, 0)
    except (OSError, subprocess.SubprocessError) as e:
        report.update({"result": "failed", "error": "launchctl: " + e.__class__.__name__})
        return finish(report, 1)

    if not retired():
        report.update({"result": "waiting", "reason": "retire-session-atlas has not succeeded yet"})
        return finish(report, 0)

    node, version = find_node()
    if node is None:
        report.update({"result": "failed", "error": "Node {}.{} or newer was not found".format(*MIN_NODE)})
        return finish(report, 1)
    report["node"] = "{}.{}".format(*version)  # type: ignore[misc]

    plist_bytes = build_plist(node)
    plist_sha = hashlib.sha256(plist_bytes).hexdigest()
    revision = code_revision()
    state = common.read_json(state_path, {})
    plist_current = plist_path.is_file() and plist_path.read_bytes() == plist_bytes
    started_on = (state.get("revision"), state.get("plist_sha"))
    stale = started_on != (revision, plist_sha)

    if not plist_current:
        actions.append("{} the plist".format("would write" if dry else "wrote"))
        if not dry:
            plist_path.parent.mkdir(parents=True, exist_ok=True)
            common.logs_dir().mkdir(parents=True, exist_ok=True)
            tmp = plist_path.with_name(plist_path.name + ".josh360-tmp")
            tmp.write_bytes(plist_bytes)
            os.replace(str(tmp), str(plist_path))

    if not loaded:
        actions.append("{} the service".format("would load" if dry else "loaded"))
        if not dry:
            r = _run(["bootstrap", domain, str(plist_path)])
            if r.returncode != 0:
                actions[-1] = "bootstrap FAILED (exit {})".format(r.returncode)
    elif stale or not plist_current:
        actions.append("{} the service".format("would restart" if dry else "restarted"))
        if not dry:
            r = _run(["kickstart", "-k", "{}/{}".format(domain, LABEL)])
            if r.returncode != 0:
                actions[-1] = "kickstart FAILED (exit {})".format(r.returncode)
    else:
        actions.append("already running on the latest code")

    if dry:
        report["result"] = "ok"
        return finish(report, 0)
    up = is_loaded(domain)
    report["loaded"] = up
    if up:
        common.state_dir().mkdir(parents=True, exist_ok=True)
        state_path.write_text(json.dumps({"revision": revision, "plist_sha": plist_sha}, sort_keys=True) + "\n", encoding="utf-8")
    report["result"] = "ok" if up else "failed"
    return finish(report, 0 if up else 1)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
