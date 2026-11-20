"""Which hook blocked (JP-182).

A transcript names a hook only as "command hook" or "command hook N" (the Nth of the hooks that ran for that call),
so the hook is found from what else is known, in this order:

  1. command in message   older Claude Code versions put the hook's own command in the label
  2. hooks.log            the josh-360 dispatcher logs "<time> <Event> <file> blocked (exit 2)"; a line for the same
                          event from 30 seconds before to 5 seconds after the block names the josh-360 file
  3. message text         runs of four words from the message found in one candidate's source (its script and the
                          files that script names), and in no other candidate's script as often
  4. only candidate       exactly one hook runs for that event, tool and folder (flagged when its source is readable
                          and holds none of the message, which happens when the hooks changed since the block)
  5. unknown              anything else; the candidates are listed so the reviewing agent can decide
"""
from __future__ import annotations

import datetime
import os
import re
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from . import inventory

GENERIC_LABEL = re.compile(r"^command hook( \d+)?$")
LOG_BEFORE, LOG_AFTER = 30, 5
SOURCE_SUFFIXES = (".py", ".js", ".mjs", ".cjs", ".ts", ".mts", ".sh", ".bash", "")
MAX_BYTES = 1024 * 1024
PATH_TOKEN = re.compile(r"[A-Za-z0-9_.~/-]+\.(?:py|js|mjs|cjs|ts|mts|sh)\b")
JS_IMPORT = re.compile(r"""(?:from|require\(|import\()\s*['"](\.{1,2}/[^'"]+)['"]""")


def epoch(ts: str) -> Optional[float]:
    """Seconds from an ISO time such as 2026-11-20T14:11:15.323Z (Python 3.9's fromisoformat takes no "Z")."""
    m = re.match(r"^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)?$", (ts or "").strip())
    if not m:
        return None
    when = datetime.datetime.strptime(m.group(1), "%Y-%m-%dT%H:%M:%S")
    zone = m.group(3) or "Z"
    offset = 0 if zone == "Z" else (1 if zone[0] == "+" else -1) * (int(zone[1:3]) * 3600 + int(zone[4:6]) * 60)
    frac = float("0." + m.group(2)) if m.group(2) else 0.0
    return when.replace(tzinfo=datetime.timezone.utc).timestamp() - offset + frac


def read_hooks_log(path: Path) -> Tuple[List[Dict], str]:
    """The dispatcher's block lines: [{"t", "event", "name", "used"}], or ([], why) when the log cannot be read."""
    if not path.is_file():
        return [], ""
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError as e:
        return [], "{} cannot be read ({})".format(path, e.__class__.__name__)
    out = []
    for line in lines:
        parts = line.split(" ", 3)
        if len(parts) == 4 and parts[3].startswith("blocked"):
            t = epoch(parts[0])
            if t is not None:
                out.append({"t": t, "event": parts[1], "name": parts[2], "used": False})
    return out, ""


def _repo_root(path: Path) -> Optional[Path]:
    for p in [path.parent] + list(path.parents):
        if (p / ".git").exists():
            return p
    return None


class Sources:
    """The source text of each hook's script and the files it names, read once."""

    def __init__(self) -> None:
        self.cache: Dict[str, Tuple[str, str]] = {}

    @staticmethod
    def _read(path: Path) -> str:
        try:
            if path.is_file() and path.stat().st_size <= MAX_BYTES and path.suffix in SOURCE_SUFFIXES:
                return path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            pass
        return ""

    def _named(self, script: Path, text: str) -> List[Path]:
        roots = [script.parent] + ([_repo_root(script)] if _repo_root(script) else [])
        found: List[Path] = []
        for token in PATH_TOKEN.findall(text):
            for root in roots:
                p = Path(os.path.expanduser(token)) if token.startswith(("/", "~")) else root / token
                if p.is_file() and p not in found and p != script:
                    found.append(p)
                    break
        for rel in JS_IMPORT.findall(text):
            base = script.parent / rel
            for p in [base] + [base.with_suffix(s) for s in (".ts", ".js", ".mjs")] + [Path(str(base) + ".ts")]:
                if p.is_file() and p not in found:
                    found.append(p)
                    break
        return found[:20]

    def get(self, hook: Dict) -> Tuple[str, str]:
        """(own text, text of the files it names), lower case with spaces collapsed."""
        script = hook.get("script")
        if not script:
            return "", ""
        if script not in self.cache:
            own = self._read(Path(script))
            named = "\n".join(self._read(p) for p in self._named(Path(script), own)) if own else ""
            self.cache[script] = (_flat(own), _flat(named))
        return self.cache[script]


WORD = re.compile(r"[a-z][a-z0-9'_-]*")


def _flat(text: str) -> str:
    """The words of a source file, lower case, one space apart, so punctuation and line breaks never split a phrase."""
    return " " + " ".join(WORD.findall(text.lower())) + " "


def phrases(message: str, n: int = 4) -> List[str]:
    w = WORD.findall(message.lower())
    found = {" ".join(w[i:i + n]) for i in range(len(w) - n + 1)} if len(w) >= n else ({" ".join(w)} if w else set())
    return [" {} ".format(p) for p in sorted(found)]


def _by_text(block: Dict, cands: List[Dict], sources: Sources) -> Optional[Dict]:
    ps = phrases(block["message"])
    if not ps:
        return None
    scored = []
    for h in cands:
        own, named = sources.get(h)
        scored.append(((sum(p in own for p in ps), sum(p in named for p in ps)), h))
    scored.sort(key=lambda x: x[0], reverse=True)
    if scored and scored[0][0] > (0, 0) and (len(scored) == 1 or scored[0][0] > scored[1][0]):
        return scored[0][1]
    return None


def _by_log(block: Dict, cands: List[Dict], log: List[Dict], hooks: List[Dict]) -> Optional[Dict]:
    t = epoch(block["ts"])
    if t is None or not any(h["source"] == "josh-360" for h in cands):
        return None
    near = [e for e in log if not e["used"] and e["event"] == block["event"] and -LOG_BEFORE <= e["t"] - t <= LOG_AFTER]
    if not near:
        return None
    entry = min(near, key=lambda e: abs(e["t"] - t))
    entry["used"] = True
    hid = "josh-360:{}/{}".format(block["event"], entry["name"])
    found = next((h for h in hooks if h["id"] == hid), None)
    return found or inventory.Hook(id=hid, source="josh-360", source_path="", event=block["event"], matcher=None,
                                   command=entry["name"], script=None, scope=None, via=None,
                                   note="named by hooks.log; no longer in the laptop copy")


def attribute(block: Dict, hooks: List[Dict], log: List[Dict], sources: Sources) -> Tuple[Optional[Dict], str, List[str]]:
    """(hook or None, how it was found, the candidates' ids)."""
    cands = inventory.candidates(hooks, block["event"], block.get("tool"), block.get("folder") or None)
    ids = [h["id"] for h in cands]
    label = str(block.get("label") or "")
    if label and not GENERIC_LABEL.match(label):
        hit = [h for h in hooks if h["event"] == block["event"] and (label == h["command"] or label in h["command"]
               or (h.get("script") and os.path.basename(h["script"]) in label))]
        if len(hit) == 1:
            return hit[0], "command in message", ids
    found = _by_log(block, cands, log, hooks)
    if found is not None:
        return found, "hooks.log", ids
    found = _by_text(block, cands, sources)
    if found is not None:
        return found, "message text", ids
    if len(cands) == 1:
        own, named = sources.get(cands[0])
        ps = phrases(block["message"])
        if (own or named) and ps and not any(p in own or p in named for p in ps):
            return cands[0], "only candidate, but its source does not hold the message", ids
        return cands[0], "only candidate", ids
    return None, "unknown", ids
