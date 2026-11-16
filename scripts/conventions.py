#!/usr/bin/env python3
"""Read and check the conventions files (JP-98): conventions/registry.yaml and conventions/priorities.yaml.

Commands:
  check     Validate both files. Exit 0 when they pass, 1 with one line per problem, each naming the entry.
  lookup    --folder PATH [--home DIR] or --repo NAME. Print the system, area, Jira space, default epic and
            priority as JSON. A folder or repository no system lists is Unassigned: nothing is guessed.
  priority  [--epic KEY] [--initiative KEY] [--area NAME]. Print the priority those Jira links fall under.

No AI and no network: answers come only from the two files. Rules: conventions/tickets.md, "Routing".
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path, PurePosixPath

import yaml

ROOT = Path(__file__).resolve().parent.parent
REGISTRY = ROOT / "conventions/registry.yaml"
PRIORITIES = ROOT / "conventions/priorities.yaml"

STANDING_IDS = ("athena", "equip", "pims", "ma-clinical-data-transfer", "clinician-tech-stack-ux",
                "ai-scribing-utilization")
KINDS = {"standing", "devex", "unassigned"}
TRACKERS = {"jira", "linear"}
INITIATIVE_SPACE = "TECH"  # holds initiatives only; never a ticket's space or a system's
KEY = re.compile(r"^[A-Z][A-Z0-9]+-[1-9][0-9]*$")
LABEL = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
SYSTEM_KEYS = {"name", "description", "repositories", "folders", "area", "tracker", "jira_space",
               "linear_team", "default_epic", "priority", "notes"}
PRIORITY_KEYS = {"id", "name", "kind", "rank", "shown_to", "covers", "notes"}
COVER_KEYS = {"areas", "initiatives", "epics"}


class ConventionsFileError(Exception):
    """A conventions file that cannot be read or is not valid YAML. The message names the file."""


def load(path: Path) -> dict:
    try:
        with open(path, encoding="utf-8") as handle:
            data = yaml.safe_load(handle)
    except OSError as exc:
        raise ConventionsFileError(f"{Path(path).name}: cannot be read ({exc.strerror or exc})") from exc
    except yaml.YAMLError as exc:
        mark = getattr(exc, "problem_mark", None)
        at = f" at line {mark.line + 1}" if mark is not None else ""
        reason = getattr(exc, "problem", None) or exc
        raise ConventionsFileError(f"{Path(path).name}: not valid YAML{at} ({reason})") from exc
    if data is None:
        return {}
    if not isinstance(data, dict):
        raise ConventionsFileError(f"{Path(path).name}: the top level must be a mapping, not a {type(data).__name__}")
    return data


def _list(value) -> list:
    return value if isinstance(value, list) else []


def _covers(prio: dict) -> dict:
    return prio.get("covers") if isinstance(prio.get("covers"), dict) else {}


def _type_problems(entry: dict, where: str, strings: tuple, lists: tuple = (), mappings: tuple = ()) -> list[str]:
    """One line per field whose value has the wrong type. A missing or null field is left to the other checks."""
    problems = []
    for key in strings:
        if entry.get(key) is not None and not isinstance(entry.get(key), str):
            problems.append(f"{where}: {key} must be text, not a {type(entry.get(key)).__name__}")
    for key in lists:
        value = entry.get(key)
        if value is not None and not (isinstance(value, list) and all(isinstance(v, str) for v in value)):
            problems.append(f"{where}: {key} must be a list of text")
    for key in mappings:
        if entry.get(key) is not None and not isinstance(entry.get(key), dict):
            problems.append(f"{where}: {key} must be a mapping, not a {type(entry.get(key)).__name__}")
    return problems


def validate(registry: dict, priorities: dict) -> list[str]:
    """Every problem in the two files, one line each, naming the entry. An empty list means both pass. A
    malformed entry (a list where a mapping belongs, a number where text belongs) is reported by name, never
    raised."""
    problems: list[str] = []
    prios = _list(priorities.get("priorities"))
    prio_ids = [p.get("id") for p in prios if isinstance(p, dict) and isinstance(p.get("id"), str)]
    spaces = registry.get("spaces") if isinstance(registry.get("spaces"), dict) else {}
    areas = registry.get("areas") if isinstance(registry.get("areas"), dict) else {}
    ticket_spaces = {s for s in spaces if s != INITIATIVE_SPACE}
    area_priority = {a: p.get("id") for p in prios if isinstance(p, dict)
                     for a in _list(_covers(p).get("areas")) if isinstance(a, str)}
    for section in ("spaces", "areas", "fallback"):
        if registry.get(section) is not None and not isinstance(registry.get(section), dict):
            problems.append(f"registry: {section} must be a mapping, not a {type(registry.get(section)).__name__}")
    for section, value in (("registry: systems", registry.get("systems")),
                           ("priorities: priorities", priorities.get("priorities"))):
        if value is not None and not isinstance(value, list):
            problems.append(f"{section} must be a list, not a {type(value).__name__}")

    if not spaces:
        problems.append("registry: no spaces listed")
    fallback = registry.get("fallback") if isinstance(registry.get("fallback"), dict) else {}
    if fallback.get("jira_space") not in ticket_spaces:
        problems.append(f"registry fallback: jira_space {fallback.get('jira_space')!r} is not a ticket space")
    if fallback.get("priority") not in prio_ids:
        problems.append(f"registry fallback: priority {fallback.get('priority')!r} is not in priorities.yaml")

    systems = _list(registry.get("systems"))
    if not systems:
        problems.append("registry: no systems listed")
    seen_names: set[str] = set()
    folder_owner: dict[str, str] = {}
    repo_owner: dict[str, str] = {}
    for n, system in enumerate(systems, 1):
        if not isinstance(system, dict):
            problems.append(f"registry system #{n}: not a mapping")
            continue
        name = system.get("name") if isinstance(system.get("name"), str) else None
        name = name or f"#{n}"
        where = f"registry system {name}"
        typed = _type_problems(system, where, strings=("name", "description", "area", "tracker", "jira_space",
                                                       "linear_team", "default_epic", "priority", "notes"),
                               lists=("repositories", "folders"))
        if typed:
            problems += typed
            continue
        try:
            problems += _system_problems(system, name, where, n, seen_names, folder_owner, repo_owner,
                                         ticket_spaces, areas, prio_ids, area_priority)
        except (TypeError, AttributeError, ValueError) as exc:
            problems.append(f"{where}: malformed ({exc})")

    problems += _validate_priorities(prios, areas)
    return problems


def _system_problems(system: dict, name: str, where: str, n: int, seen_names: set, folder_owner: dict,
                 repo_owner: dict, ticket_spaces: set, areas: dict, prio_ids: list,
                 area_priority: dict) -> list[str]:
    problems: list[str] = []
    for key in sorted(str(k) for k in set(system) - SYSTEM_KEYS):
        problems.append(f"{where}: unknown field {key!r}")
    if not system.get("name"):
        problems.append(f"{where}: no name")
    elif not LABEL.match(name):
        problems.append(f"{where}: name must be the lowercase repository-style label")
    if name in seen_names:
        problems.append(f"{where}: name listed more than once")
    seen_names.add(name)
    if not system.get("description"):
        problems.append(f"{where}: no description")

    repos = _list(system.get("repositories"))
    folders = _list(system.get("folders"))
    if not repos and not folders:
        problems.append(f"{where}: lists no repositories and no folders, so nothing can resolve to it")
    for repo in repos:
        key = _repo_name(str(repo))
        if not key or "/" in str(repo):
            problems.append(f"{where}: repository {repo!r} must be a bare repository name")
        elif key in repo_owner:
            problems.append(f"{where}: repository {repo!r} is already listed by {repo_owner[key]}")
        else:
            repo_owner[key] = name
    for folder in folders:
        text = str(folder)
        if not (text.startswith("~/") or text.startswith("/")):
            problems.append(f"{where}: folder {text!r} must start with ~/ or /")
            continue
        norm = _norm(text, home="~")
        if norm in folder_owner:
            problems.append(f"{where}: folder {text!r} is already listed by {folder_owner[norm]}")
        else:
            folder_owner[norm] = name

    tracker = system.get("tracker")
    if tracker not in TRACKERS:
        problems.append(f"{where}: tracker must be one of {sorted(TRACKERS)}, not {tracker!r}")
    if tracker == "jira":
        space = system.get("jira_space")
        if not space:
            problems.append(f"{where}: no jira_space")
        elif space == INITIATIVE_SPACE:
            problems.append(f"{where}: jira_space {INITIATIVE_SPACE} holds initiatives only, never tickets")
        elif space not in ticket_spaces:
            problems.append(f"{where}: jira_space {space!r} is not listed under spaces")
        epic = system.get("default_epic")
        if epic is not None:
            if not KEY.match(str(epic)):
                problems.append(f"{where}: default_epic {epic!r} is not a Jira key")
            elif space and not str(epic).startswith(f"{space}-"):
                problems.append(f"{where}: default_epic {epic} is not in its jira_space {space} "
                                "(a parent must be in the same space)")
        if not system.get("area"):
            problems.append(f"{where}: no area")
    if tracker == "linear":
        if not system.get("linear_team"):
            problems.append(f"{where}: no linear_team")
        if system.get("jira_space") or system.get("default_epic"):
            problems.append(f"{where}: a Linear system has no jira_space or default_epic")
    area = system.get("area")
    if area and area not in areas:
        problems.append(f"{where}: area {area!r} is not listed under areas")
    if system.get("priority") not in prio_ids:
        problems.append(f"{where}: priority {system.get('priority')!r} is not in priorities.yaml")
    elif area and area_priority.get(area) and area_priority[area] != system.get("priority"):
        problems.append(f"{where}: priority {system.get('priority')!r} disagrees with its area {area!r}, "
                        f"which priorities.yaml puts under {area_priority[area]!r}")
    return problems


def _validate_priorities(prios: list, areas: dict) -> list[str]:
    problems: list[str] = []
    if not prios:
        return ["priorities: none listed"]
    claimed: dict[tuple[str, str], str] = {}
    ids: list[str] = []
    for n, prio in enumerate(prios, 1):
        if not isinstance(prio, dict):
            problems.append(f"priorities #{n}: not a mapping")
            continue
        pid = prio.get("id") if isinstance(prio.get("id"), str) else None
        pid = pid or f"#{n}"
        where = f"priority {pid}"
        ids.append(pid)
        typed = _type_problems(prio, where, strings=("id", "name", "kind", "notes"), mappings=("covers",))
        covers = _covers(prio)
        for key in sorted(COVER_KEYS):
            value = covers.get(key)
            if value is not None and not (isinstance(value, list) and all(isinstance(v, str) for v in value)):
                typed.append(f"{where}: covers {key} must be a list of text")
        if typed:
            problems += typed
            continue
        try:
            problems += _priority_problems(prio, pid, where, areas, claimed)
        except (TypeError, AttributeError, ValueError) as exc:
            problems.append(f"{where}: malformed ({exc})")
    problems += _priority_set_problems(prios, ids)
    return problems


def _priority_problems(prio: dict, pid: str, where: str, areas: dict, claimed: dict) -> list[str]:
    problems: list[str] = []
    for key in sorted(str(k) for k in set(prio) - PRIORITY_KEYS):
        problems.append(f"{where}: unknown field {key!r}")
    if not prio.get("name"):
        problems.append(f"{where}: no name")
    kind = prio.get("kind")
    if kind not in KINDS:
        problems.append(f"{where}: kind must be one of {sorted(KINDS)}, not {kind!r}")
    if kind == "standing" and pid not in STANDING_IDS:
        problems.append(f"{where}: is not one of the six standing priorities {list(STANDING_IDS)}")
    covers = _covers(prio)
    for key in sorted(str(k) for k in set(covers) - COVER_KEYS):
        problems.append(f"{where}: covers has unknown field {key!r}")
    if kind == "unassigned" and any(_list(covers.get(k)) for k in COVER_KEYS):
        problems.append(f"{where}: unassigned covers nothing; it is what is left over")
    for key in sorted(COVER_KEYS):
        for item in _list(covers.get(key)):
            if key in ("initiatives", "epics") and not KEY.match(str(item)):
                problems.append(f"{where}: {key} entry {item!r} is not a Jira key")
            if key == "initiatives" and KEY.match(str(item)) and not str(item).startswith(f"{INITIATIVE_SPACE}-"):
                problems.append(f"{where}: initiative {item} is not in the {INITIATIVE_SPACE} space")
            if key == "areas" and item not in areas:
                problems.append(f"{where}: area {item!r} is not listed under areas in registry.yaml")
            if (key, item) in claimed:
                problems.append(f"{where}: {item} is already covered by {claimed[(key, item)]}; "
                                "one link may point at one priority only")
            else:
                claimed[(key, item)] = pid
    return problems


def _priority_set_problems(prios: list, ids: list) -> list[str]:
    problems: list[str] = []
    for pid in STANDING_IDS:
        if ids.count(pid) != 1:
            problems.append(f"priority {pid}: the standing priority must appear exactly once")
    for kind in ("devex", "unassigned"):
        count = sum(1 for p in prios if isinstance(p, dict) and p.get("kind") == kind)
        if count != 1:
            problems.append(f"priority {kind}: exactly one priority of kind {kind} is required, found {count}")
    if "unassigned" not in ids:
        problems.append("priority unassigned: the id 'unassigned' is required")
    for pid in set(ids):
        if ids.count(pid) > 1 and pid not in STANDING_IDS:
            problems.append(f"priority {pid}: listed more than once")
    return problems


def _norm(path: str, home: str) -> str:
    """An absolute folder path with ~ expanded and . and .. removed. No disk access: the folder may live on
    another machine."""
    text = str(path)
    if text == "~" or text.startswith("~/"):
        text = home.rstrip("/") + text[1:]
    return os.path.normpath(text)


def _inside(path: str, folder: str) -> bool:
    return PurePosixPath(path) == PurePosixPath(folder) or PurePosixPath(folder) in PurePosixPath(path).parents


def _repo_name(repo: str) -> str:
    name = repo.strip().rstrip("/").rsplit("/", 1)[-1].rsplit(":", 1)[-1]
    # Folders use underscores where repository names use hyphens (josh_projects for josh-projects), and
    # labels in use mix both, so the two count as one spelling.
    return (name[:-4] if name.endswith(".git") else name).lower().replace("_", "-")


def _answer(registry: dict, system: dict | None, matched: str | None) -> dict:
    fallback = registry.get("fallback") or {}
    if system is None:
        return {"system": None, "area": None, "tracker": "jira", "jira_space": fallback.get("jira_space"),
                "linear_team": None, "default_epic": None, "priority": fallback.get("priority"),
                "unassigned": True, "matched": None}
    return {"system": system["name"], "area": system.get("area"), "tracker": system.get("tracker"),
            "jira_space": system.get("jira_space"), "linear_team": system.get("linear_team"),
            "default_epic": system.get("default_epic"), "priority": system.get("priority"),
            "unassigned": False, "matched": matched}


def lookup_folder(registry: dict, folder: str, home: str | None = None) -> dict:
    """The system whose listed folder holds this folder; the deepest listed folder wins. Containment is by
    whole path parts, so `.../app-old` never matches `.../app`. No match is Unassigned."""
    home = home or str(Path.home())
    text = str(folder)
    if not (text == "~" or text.startswith("~/") or os.path.isabs(text)):
        text = os.path.abspath(text)  # a relative folder, such as `.`, is relative to where the command runs
    target = _norm(text, home)
    best, best_folder = None, None
    for system in _list(registry.get("systems")):
        for listed in _list(system.get("folders")):
            norm = _norm(str(listed), home)
            if _inside(target, norm) and (best_folder is None or len(norm) > len(best_folder)):
                best, best_folder = system, norm
    return _answer(registry, best, best_folder)


def lookup_repo(registry: dict, repo: str) -> dict:
    """The system listing this repository name (owner and .git ignored, case-insensitive). No match is
    Unassigned."""
    wanted = _repo_name(repo)
    for system in _list(registry.get("systems")):
        if wanted in {_repo_name(str(r)) for r in _list(system.get("repositories"))}:
            return _answer(registry, system, wanted)
    return _answer(registry, None, None)


def priority_for(priorities: dict, epic: str | None = None, initiative: str | None = None,
                 area: str | None = None) -> str:
    """Epic first, then initiative, then area; anything else is Unassigned."""
    for key, value in (("epics", epic), ("initiatives", initiative), ("areas", area)):
        if not value:
            continue
        for prio in _list(priorities.get("priorities")):
            if value in _list((prio.get("covers") or {}).get(key)):
                return prio["id"]
    return "unassigned"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--registry", type=Path, default=REGISTRY)
    parser.add_argument("--priorities", type=Path, default=PRIORITIES)
    sub = parser.add_subparsers(dest="command", required=True)
    check = sub.add_parser("check", help="validate both files")
    check.add_argument("--registry", type=Path, default=argparse.SUPPRESS)
    check.add_argument("--priorities", type=Path, default=argparse.SUPPRESS)
    look = sub.add_parser("lookup", help="find the home of a folder or repository")
    group = look.add_mutually_exclusive_group(required=True)
    group.add_argument("--folder")
    group.add_argument("--repo")
    look.add_argument("--home", help="the home folder ~ stands for (default: this machine's)")
    prio = sub.add_parser("priority", help="the priority for a ticket's Jira links")
    prio.add_argument("--epic")
    prio.add_argument("--initiative")
    prio.add_argument("--area")
    args = parser.parse_args(argv)
    try:
        return _run(args)
    except ConventionsFileError as exc:
        print(exc)
        if args.command == "check":
            print("conventions: FAILED (1 problem(s))")
        return 1


def _run(args: argparse.Namespace) -> int:
    if args.command == "check":
        found = validate(load(args.registry), load(args.priorities))
        for line in found:
            print(line)
        print(f"conventions: {'FAILED' if found else 'ok'} ({len(found)} problem(s))")
        return 1 if found else 0
    if args.command == "lookup":
        registry = load(args.registry)
        answer = (lookup_folder(registry, args.folder, home=args.home) if args.folder
                  else lookup_repo(registry, args.repo))
        print(json.dumps(answer, indent=2))
        return 0
    print(json.dumps({"priority": priority_for(load(args.priorities), args.epic, args.initiative, args.area)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
