"""How a console event looks (JP-185). Python 3.9, standard library only.

One line per event: local time, a fixed-width source tag, a mark, then the text, with ticket keys and run ids
picked out. Colors are ANSI codes and are left out entirely when color is off, so piped output is plain text.
"""
from __future__ import annotations

import datetime
import re
from typing import Optional

from . import events as ev

RESET = "\033[0m"
BOLD, DIM = "1", "2"
STYLE = {
    "error": ("1;31", "✖"),     # bold red, heavy x
    "stop": ("1;33", "■"),      # bold yellow, square
    "needs": ("1;35", "◆"),     # bold magenta, diamond (and the badge)
    "start": ("36", "▶"),       # cyan, play
    "ok": ("32", "✔"),          # green, tick
    "info": ("0", "·"),         # plain, dot
    "quiet": ("2", "·"),        # dim, dot
}
SOURCE_STYLE = {"graph": "1;34", "ledger": "34", "runner": "36", "advance": "2;36", "job": "37", "hooks": "35",
                "session": "2", "console": "2;33"}
BADGE = "\033[1;97;45m NEEDS JOSH \033[0m"
TAG_WIDTH = 7
KEY_STYLE = "1;4;94"                 # bold, underlined, bright blue
RUN_STYLE = "2;36"
HIGHLIGHT = re.compile(r"\b(?:[A-Z][A-Z0-9]{1,9}-\d+|r-[0-9a-f]{6,16})\b")


def paint(code: str, text: str, color: bool) -> str:
    return "\033[{}m{}{}".format(code, text, RESET) if color and code != "0" else text


def local_time(stamp: str) -> str:
    """HH:MM:SS in the laptop's own time zone."""
    when = ev.normalise(stamp)
    if when is None:
        return "--:--:--"
    parsed = datetime.datetime.strptime(when, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)
    return parsed.astimezone().strftime("%H:%M:%S")


def _highlight(text: str, base: str, color: bool) -> str:
    if not color:
        return text

    def swap(found: "re.Match") -> str:
        style = RUN_STYLE if found.group(0).startswith("r-") else KEY_STYLE
        return "\033[{}m{}\033[0m\033[{}m".format(style, found.group(0), base)

    return "\033[{}m{}{}".format(base, HIGHLIGHT.sub(swap, text), RESET)


def line(event: ev.Event, color: bool, width: Optional[int] = None) -> str:
    code, mark = STYLE.get(event.kind, STYLE["info"])
    tag = event.source[:TAG_WIDTH].ljust(TAG_WIDTH)
    text = event.text
    if event.ticket and event.ticket not in text:
        text = "{} {}".format(event.ticket, text)
    if width:
        room = max(20, width - 22 - (13 if event.kind == "needs" else 0))
        text = ev.shorten(text, room)
    parts = [paint(DIM, local_time(event.at), color), paint(SOURCE_STYLE.get(event.source, "0"), tag, color),
             paint(code, mark, color)]
    if event.kind == "needs":
        parts.append(BADGE if color else "[NEEDS JOSH]")
    parts.append(_highlight(text, code, color))
    return " ".join(parts)
