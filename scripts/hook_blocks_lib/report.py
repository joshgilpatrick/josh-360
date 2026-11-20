"""The review file (JP-182): Markdown for the agent to read, and the same data as JSON."""
from __future__ import annotations

from typing import Dict, List

EXAMPLES_PER_HOOK = 25
BLOCK_KEYS = ("ts", "session", "agent", "folder", "event", "tool", "hook", "found_by", "candidates", "label",
              "attempted", "message", "next", "next_note", "false_alarm", "transcript", "shape")


def summarise(hooks: List[Dict], blocks: List[Dict]) -> List[Dict]:
    """One row per hook, every listed hook included (0 blocks too), plus one per event for blocks nobody claims."""
    rows: Dict[str, Dict] = {}
    for h in hooks:
        rows[h["id"]] = dict(id=h["id"], source=h["source"], source_path=h["source_path"], event=h["event"],
                             matcher=h["matcher"], script=h.get("script"), scope=h.get("scope"), note=h.get("note", ""),
                             blocks=0, false_alarms=0)
    for b in blocks:
        row = rows.get(b["hook"])
        if row is None:
            row = rows[b["hook"]] = dict(id=b["hook"], source="unknown" if b["found_by"] == "unknown" else "",
                                         source_path="", event=b["event"], matcher=None, script=None, scope=None,
                                         note="", blocks=0, false_alarms=0)
        row["blocks"] += 1
        row["false_alarms"] += 1 if b["false_alarm"] else 0
    return sorted(rows.values(), key=lambda r: (-r["blocks"], -r["false_alarms"], r["event"], r["id"]))


def as_json(meta: Dict, rows: List[Dict], blocks: List[Dict]) -> Dict:
    return dict(schema=1, **meta, hooks=rows, blocks=[{k: b.get(k) for k in BLOCK_KEYS} for b in blocks])


def _code(text: str) -> str:
    return "`{}`".format(str(text).replace("`", "'")) if text else "(none)"


def markdown(meta: Dict, rows: List[Dict], blocks: List[Dict]) -> str:
    total = len(blocks)
    alarms = sum(1 for b in blocks if b["false_alarm"])
    blocking = [r for r in rows if r["blocks"]]
    out = ["# Hook block review", "",
           "Made {} for the {} days since {}. Read {} transcripts ({} skipped, {} partly read). {} blocks by {} hooks; "
           "{} look like false alarms. {} hooks are listed in all.".format(
               meta["generated"], meta["window_days"], meta["since"], meta["transcripts"]["read"],
               len(meta["transcripts"]["skipped"]), len(meta["transcripts"]["partly"]), total, len(blocking), alarms,
               len(rows)), "",
           "This file can hold patient data: it quotes blocked commands, prompts and messages. It stays on this laptop. "
           "Never paste it into GitHub, Jira or the laptop-status branch; hook names and counts are the only parts "
           "that may go anywhere else.", "",
           "## Contents", "",
           "- [Summary by hook](#summary-by-hook)",
           "- [Blocks](#blocks)",
           "- [Skipped transcripts](#skipped-transcripts)",
           "- [Settings that could not be read](#settings-that-could-not-be-read)",
           "- [How to read this file](#how-to-read-this-file)", "",
           "## Summary by hook", "",
           "| Hook | Source | Event | Matcher | Blocks | Likely false alarms | Script |",
           "| --- | --- | --- | --- | --- | --- | --- |"]
    for r in rows:
        note = " ({})".format(r["note"]) if r["note"] else ""
        out.append("| {} | {} | {} | {} | {} | {} | {} |".format(
            r["id"].replace("|", "\\|") + note, r["source"] or "-", r["event"],
            _code(r["matcher"]).replace("|", "\\|") if r["matcher"] not in (None, "") else "all",
            r["blocks"], r["false_alarms"], _code(r["script"] or r["source_path"] or "").replace("|", "\\|")))
    out += ["", "## Blocks", ""]
    if not blocks:
        out.append("No hook blocked anything in the window.")
    for r in blocking:
        mine = [b for b in blocks if b["hook"] == r["id"]]
        out += ["### {}".format(r["id"]), "",
                "{} blocks, {} likely false alarms. Source: {}.".format(
                    r["blocks"], r["false_alarms"], _code(r["script"] or r["source_path"] or "not known")), ""]
        for b in mine[:EXAMPLES_PER_HOOK]:
            who = "session {}".format(_code(b["session"])) + (" subagent {}".format(_code(b["agent"])) if b["agent"] else "")
            out += ["- **{}**, {}, folder {}".format(b["ts"], who, _code(b["folder"])),
                    "  - Event and tool: {}{}".format(b["event"], " / " + b["tool"] if b["tool"] else ""),
                    "  - Hook: {} (found by {}{}{})".format(
                        b["hook"], b["found_by"], "; label " + _code(b["label"]) if b["label"] else "",
                        "; candidates: " + ", ".join(b["candidates"]) if b["found_by"] == "unknown" and b["candidates"]
                        else ""),
                    "  - Attempted: {}".format(_code(b["attempted"])),
                    "  - Message: {}".format(_code(b["message"][:600])),
                    "  - Next: {} ({})".format(b["next"], b["next_note"]),
                    "  - Likely false alarm: {}".format("yes, " + b["false_alarm"] if b["false_alarm"] else "no"),
                    "  - Transcript: {}".format(_code(b["transcript"]))]
        if len(mine) > EXAMPLES_PER_HOOK:
            out.append("- {} more blocks are in the JSON file beside this one.".format(len(mine) - EXAMPLES_PER_HOOK))
        out.append("")
    out += ["## Skipped transcripts", ""]
    skipped, partly = meta["transcripts"]["skipped"], meta["transcripts"]["partly"]
    if not skipped and not partly:
        out.append("None: every transcript in the window was read.")
    out += ["- {}: skipped, {}".format(_code(s["path"]), s["why"]) for s in skipped]
    out += ["- {}: read, but {} lines were not JSON".format(_code(p["path"]), p["bad_lines"]) for p in partly]
    out += ["", "## Settings that could not be read", ""]
    out += ["- {}".format(p) for p in meta["settings_problems"]] or ["None."]
    out += ["", "## How to read this file", "",
            "- A hook is named by its source: `user` (~/.claude/settings.json), `project <folder>`, `plugin <name>`, "
            "`extra <file>` (a settings file passed with --settings), `managed`, or `josh-360:<Event>/<file>` (a file "
            "the josh-360 dispatcher runs).",
            "- Found by: `hooks.log` (the dispatcher's log names the file), `message text` (the message's wording is in "
            "that hook's source), `only candidate` (the one hook that runs there), `command in message`, or "
            "`unknown` (several hooks could have done it; the candidates are listed).",
            "- Next: retried, other-way-succeeded, other-way-failed, asked-josh, gave-up, moved-on, continued (Stop), "
            "unknown (nothing follows in the transcript).",
            "- Likely false alarm: the same job was done straight after another way, or the blocked call reads only. "
            "It is a pointer for the reviewer, not a verdict.", ""]
    return "\n".join(out)
