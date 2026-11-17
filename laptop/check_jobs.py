#!/usr/bin/env python3
"""JP-119: compare what runs on the laptop with the startup list, and print every difference.

    python3 laptop/check_jobs.py                 print the differences (exit 1 if there are any)
    python3 laptop/check_jobs.py --json          the same, as one JSON report
    python3 laptop/check_jobs.py --startup-repo <folder>   where macbook-automations is checked out

"The list" is the macbook-automations startup list: `launchd/startup-manifest.txt` and the plists it names.
Josh 360's own jobs are the entries in jobs.yaml, which that list starts through one entry,
com.jgilpatrick.josh-360-jobs. `laptop/launchd-register.json` names what is allowed to run beside the list and why
(managed by another project, retired, or waiting to move onto the list).

It reads three things and changes nothing: `launchctl list`, the plists in ~/Library/LaunchAgents, and the
startup list. It prints these differences:

- stray: a job that is loaded or installed, that Josh owns (a plist in ~/Library/LaunchAgents, or a loaded label
  under one of his prefixes), and that is neither on the list nor in the register.
- retired but present: a job the register says was retired that is still loaded or still has its plist installed.
- Josh 360 job not on the list: a com.josh360.* job that is running or installed and is not on the startup list.
  The register may name one as transitional; it is then a known gap, printed but not a failure.
- on the list but not loaded, and on the list but its plist is missing.

An unreadable startup list or an unreadable `launchctl list` is unknown, never "nothing": that part of the check is
skipped, the report says so, and the exit is 2. Python 3.9, standard library only. Override the program with
JOSH360_LAUNCHCTL and the checkout with JOSH360_STARTUP_REPO (tests do).
"""
from __future__ import annotations

import fnmatch
import json
import os
import plistlib
import subprocess
import sys
from pathlib import Path
from typing import Dict, List, Optional

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

REGISTER = Path(__file__).resolve().parent / "launchd-register.json"
DEFAULT_STARTUP_REPO = ("Development", "active", "josh_projects", "macbook_automations")
JOSH360_PREFIXES = ("com.josh360.",)


class Register:
    """The register file, read strictly: a typo stops the check rather than hiding a job."""

    def __init__(self, data: Dict[str, object]) -> None:
        keys = {"schema", "about", "entry_point", "own_prefixes", "elsewhere", "transitional", "retired", "ignore"}
        if set(data) - keys or keys - set(data):
            raise common.Unexpected("launchd-register.json: keys must be exactly {}".format(sorted(keys)))
        self.entry_point = str(data["entry_point"])
        self.own_prefixes = tuple(str(p) for p in data["own_prefixes"])  # type: ignore[union-attr]
        self.elsewhere = self._rows(data, "elsewhere", {"label", "owner", "decision", "reason"})
        self.transitional = self._rows(data, "transitional", {"label", "installed_by", "ends_with", "reason"})
        self.retired = self._rows(data, "retired", {"label", "retired_by"})
        self.ignore = self._rows(data, "ignore", {"match", "reason"})
        for row in self.elsewhere:
            if row["decision"] not in ("left", "bring-in-at-close"):
                raise common.Unexpected("launchd-register.json: decision must be left or bring-in-at-close")

    @staticmethod
    def _rows(data: Dict[str, object], name: str, keys: set) -> List[Dict[str, str]]:
        rows = data[name]
        if not isinstance(rows, list):
            raise common.Unexpected("launchd-register.json: {} must be a list".format(name))
        for row in rows:
            if not isinstance(row, dict) or set(row) != keys or not all(isinstance(v, str) and v for v in row.values()):
                raise common.Unexpected("launchd-register.json: each {} row needs exactly {}".format(name, sorted(keys)))
        return rows

    @staticmethod
    def _find(rows: List[Dict[str, str]], label: str, key: str = "label") -> Optional[Dict[str, str]]:
        for row in rows:
            if fnmatch.fnmatchcase(label, row[key]):
                return row
        return None

    def elsewhere_row(self, label: str) -> Optional[Dict[str, str]]:
        return self._find(self.elsewhere, label)

    def transitional_row(self, label: str) -> Optional[Dict[str, str]]:
        return self._find(self.transitional, label)

    def retired_row(self, label: str) -> Optional[Dict[str, str]]:
        return self._find(self.retired, label)

    def ignored(self, label: str) -> bool:
        return self._find(self.ignore, label, "match") is not None


def load_register(path: Path = REGISTER) -> Register:
    try:
        return Register(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, ValueError) as e:
        raise common.Unexpected("launchd-register.json is unreadable: {}".format(e.__class__.__name__))


def launchctl() -> str:
    return os.environ.get("JOSH360_LAUNCHCTL", "launchctl")


def parse_launchctl_list(text: str) -> Dict[str, Dict[str, object]]:
    """`launchctl list` prints a header, then `PID<TAB>Status<TAB>Label` per job (PID is - when not running)."""
    jobs: Dict[str, Dict[str, object]] = {}
    for line in text.splitlines():
        parts = line.split("\t")
        if len(parts) != 3 or parts[0] == "PID":
            continue
        jobs[parts[2].strip()] = {"running": parts[0].strip() != "-", "last_exit": parts[1].strip()}
    return jobs


def loaded_jobs() -> Optional[Dict[str, Dict[str, object]]]:
    """Every job launchd has loaded for this user, or None when that could not be read (unknown, not empty)."""
    try:
        r = subprocess.run([launchctl(), "list"], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           universal_newlines=True, timeout=60)
    except (OSError, subprocess.SubprocessError):
        return None
    if r.returncode != 0 or not r.stdout.strip():
        return None
    return parse_launchctl_list(r.stdout)


def plist_label(path: Path) -> Optional[str]:
    try:
        with path.open("rb") as f:
            label = plistlib.load(f).get("Label")
    except (OSError, ValueError, plistlib.InvalidFileException):
        return None
    return label if isinstance(label, str) and label else None


def installed_plists(folder: Path) -> Dict[str, str]:
    """label -> file name for each plist in the user's LaunchAgents folder. A plist with no readable Label counts under its file name."""
    out: Dict[str, str] = {}
    if folder.is_dir():
        for p in sorted(folder.glob("*.plist")):
            out[plist_label(p) or p.stem] = p.name
    return out


def startup_repo(arg: Optional[str]) -> Path:
    raw = arg or os.environ.get("JOSH360_STARTUP_REPO")
    return Path(raw).expanduser() if raw else Path.home().joinpath(*DEFAULT_STARTUP_REPO)


def read_startup_list(repo: Path) -> Optional[List[Dict[str, object]]]:
    """The enabled entries of launchd/startup-manifest.txt, each with its label (None when the plist is missing)."""
    manifest = repo / "launchd" / "startup-manifest.txt"
    try:
        lines = manifest.read_text(encoding="utf-8").splitlines()
    except OSError:
        return None
    entries: List[Dict[str, object]] = []
    for raw in lines:
        entry = raw.split("#", 1)[0].strip()
        if entry:
            entries.append({"entry": entry, "label": plist_label(repo / entry) if (repo / entry).is_file() else None})
    return entries


def watched(label: str, register: Register, installed: Dict[str, str]) -> bool:
    """Is this job Josh's to account for? Vendor and system jobs are not."""
    if register.ignored(label):
        return False
    return label in installed or label.startswith(register.own_prefixes)


def compare(loaded: Optional[Dict[str, Dict[str, object]]], installed: Dict[str, str],
            listed: Optional[List[Dict[str, object]]], register: Register) -> Dict[str, object]:
    differences: List[Dict[str, str]] = []
    known_gaps: List[Dict[str, str]] = []
    unknown: List[str] = []
    on_list = sorted(str(e["label"]) for e in (listed or []) if e["label"])
    on_list_set = set(on_list) | {register.entry_point}

    if listed is None:
        unknown.append("the startup list could not be read")
    else:
        for e in listed:
            if e["label"] is None:
                differences.append({"kind": "plist missing", "label": str(e["entry"]),
                                    "detail": "the startup list names this plist, but it is missing or has no Label"})
            elif loaded is not None and e["label"] not in loaded:
                differences.append({"kind": "on the list but not loaded", "label": str(e["label"]),
                                    "detail": "run scripts/startup.sh in macbook-automations"})
    if loaded is None:
        unknown.append("launchctl list could not be read")

    present = set(installed) | set(loaded or {})
    for label in sorted(present):
        is_loaded = loaded is not None and label in loaded
        is_installed = label in installed
        retired = register.retired_row(label)
        if retired and (is_loaded or is_installed):
            where = "loaded" if is_loaded else "installed (not loaded)"
            differences.append({"kind": "retired but present", "label": label,
                                "detail": "{} and still {}".format(retired["retired_by"], where)})
            continue
        if listed is not None and label in on_list_set:
            continue
        transitional = register.transitional_row(label)
        if transitional:
            known_gaps.append({"kind": "transitional", "label": label,
                               "detail": "{} Ends with {}.".format(transitional["reason"], transitional["ends_with"])})
            continue
        if register.elsewhere_row(label) or retired:
            continue
        if label.startswith(JOSH360_PREFIXES) and listed is not None:
            differences.append({"kind": "Josh 360 job not on the list", "label": label,
                                "detail": "add it to the startup list in macbook-automations"})
        elif listed is not None and watched(label, register, installed):
            differences.append({"kind": "stray", "label": label,
                                "detail": "on neither the startup list nor the register: put it on the list, name it in "
                                          "laptop/launchd-register.json with a reason, or retire it"})
    return {"on_list": on_list, "differences": differences, "known_gaps": known_gaps, "unknown": unknown}


def josh360_jobs_note(state_path: Optional[Path] = None) -> Dict[str, object]:
    """Which jobs in jobs.yaml have never run or last failed, from the runner's own state file. Counts and names only."""
    state_path = state_path or common.state_dir() / "jobs-state.json"
    try:
        jobs = common.load_jobs(common.REPO_ROOT)
        state = common.read_json(state_path, {})
    except (common.Unexpected, ValueError) as e:
        return {"error": str(e)[:200]}
    never = [str(j["id"]) for j in jobs if str(j["id"]) not in state]
    failed = [str(j["id"]) for j in jobs if str(j["id"]) in state and state[str(j["id"])].get("last_result") != 0]
    return {"listed": len(jobs), "never_run": never, "last_run_failed": failed}


def build_report(startup: Optional[str] = None, launch_agents: Optional[Path] = None) -> Dict[str, object]:
    register = load_register()
    repo = startup_repo(startup)
    listed = read_startup_list(repo)
    folder = launch_agents or Path.home() / "Library" / "LaunchAgents"
    report = compare(loaded_jobs(), installed_plists(folder), listed, register)
    report.update({"job": "launchd-check", "time": common.now_utc(), "startup_repo_found": listed is not None,
                   "josh360_jobs": josh360_jobs_note()})
    report["ok"] = not report["differences"] and not report["unknown"]
    return report


def render(report: Dict[str, object]) -> str:
    lines: List[str] = []
    for d in report["differences"]:  # type: ignore[union-attr]
        lines.append("{}: {}\n    {}".format(d["kind"], d["label"], d["detail"]))
    for g in report["known_gaps"]:  # type: ignore[union-attr]
        lines.append("known gap ({}): {}\n    {}".format(g["kind"], g["label"], g["detail"]))
    for u in report["unknown"]:  # type: ignore[union-attr]
        lines.append("unknown: {}; that part of the check was skipped".format(u))
    notes = report.get("josh360_jobs", {})
    if isinstance(notes, dict) and (notes.get("never_run") or notes.get("last_run_failed")):
        lines.append("jobs.yaml: never run: {}; last run failed: {}".format(
            ", ".join(notes.get("never_run", [])) or "none", ", ".join(notes.get("last_run_failed", [])) or "none"))
    n = len(report["on_list"])  # type: ignore[arg-type]
    lines.append("{} jobs on the startup list; {} difference(s){}.".format(
        n, len(report["differences"]), "" if report["ok"] else " (not clean)"))  # type: ignore[arg-type]
    return "\n".join(lines)


def main(argv: List[str]) -> int:
    startup = None
    args = list(argv)
    if "--startup-repo" in args:
        i = args.index("--startup-repo")
        if i + 1 >= len(args):
            print("--startup-repo needs a folder", file=sys.stderr)
            return 2
        startup = args[i + 1]
        del args[i:i + 2]
    if any(a not in ("--json",) for a in args):
        print(__doc__)
        return 2
    try:
        report = build_report(startup)
    except common.Unexpected as e:
        print("check_jobs: stopped: {}".format(e), file=sys.stderr)
        return 2
    print(json.dumps(report, indent=2, sort_keys=True) if "--json" in args else render(report))
    if report["unknown"]:
        return 2
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
