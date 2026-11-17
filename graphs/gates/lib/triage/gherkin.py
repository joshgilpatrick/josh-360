"""Finding and reading the Gherkin block in a ticket's Acceptance criteria (JP-122). Python 3.9, standard library only."""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import List, Tuple

_FENCED = re.compile(r"```[ \t]*gherkin[ \t]*\n(.*?)\n?```", re.IGNORECASE | re.DOTALL)
_WIKI = re.compile(r"\{code:gherkin\}\n?(.*?)\n?\{code\}", re.IGNORECASE | re.DOTALL)
_STEP = re.compile(r"^(Given|When|Then|And|But|\*)\b\s*(.*)$")
_SCENARIO = re.compile(r"^(Scenario Outline|Scenario Template|Scenario|Example)\s*:\s*(.*)$", re.IGNORECASE)


@dataclass
class Scenario:
    name: str
    tags: List[str] = field(default_factory=list)
    givens: int = 0
    whens: int = 0
    thens: int = 0


def find_gherkin_blocks(section: str) -> List[str]:
    """The bodies of the gherkin blocks in a section, fenced or in wiki `{code:gherkin}` markup."""
    return [m.group(1) for m in _FENCED.finditer(section or "")] + [m.group(1) for m in _WIKI.finditer(section or "")]


def strip_blocks(text: str) -> str:
    """The text with every gherkin block removed (a line ending in `?` inside one is not an open question)."""
    return _WIKI.sub("", _FENCED.sub("", text or ""))


def read_feature(block: str) -> Tuple[bool, List[Scenario]]:
    """(has a `Feature:` line, the scenarios). `And` and `But` count as the keyword before them; `Background:` Givens
    count toward every scenario; a Scenario Outline is one scenario; its Examples table is ignored; the tags are the
    `@words` on the lines just above a scenario."""
    has_feature = False
    background_givens = 0
    scenarios: List[Scenario] = []
    pending_tags: List[str] = []
    mode = ""            # "background" or "scenario": where the steps go
    last = ""            # the keyword `And`/`But` continue
    current = None
    for raw in (block or "").replace("\r\n", "\n").split("\n"):
        line = raw.strip()
        if not line or line.startswith(("#", "|")):
            continue
        if line.startswith("@"):
            pending_tags.extend(re.findall(r"@[\w-]+", line))
            continue
        lowered = line.lower()
        if lowered.startswith("feature:"):
            has_feature = True
            pending_tags = []
            continue
        if lowered.startswith("background:"):
            mode, last, current = "background", "", None
            pending_tags = []
            continue
        if lowered.startswith("examples:") or lowered.startswith("scenarios:"):
            pending_tags = []
            continue
        match = _SCENARIO.match(line)
        if match:
            current = Scenario(match.group(2).strip(), pending_tags, givens=background_givens)
            scenarios.append(current)
            mode, last, pending_tags = "scenario", "", []
            continue
        step = _STEP.match(line)
        if step:
            word = step.group(1)
            if word in ("And", "But", "*"):
                word = last
            if not word:
                continue
            last = word
            if mode == "background" and word == "Given":
                background_givens += 1
            elif mode == "scenario" and current is not None:
                if word == "Given":
                    current.givens += 1
                elif word == "When":
                    current.whens += 1
                elif word == "Then":
                    current.thens += 1
        pending_tags = []
    return has_feature, scenarios
