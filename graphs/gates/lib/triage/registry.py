"""The repository registry the gates read (JP-122): conventions/registry.json, the JSON copy of registry.yaml.

The lookup is conventions.lookup_repo (scripts/conventions.py), not a second copy of its rule. Python 3.9.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Callable, Dict, Optional, Set

ROOT = Path(__file__).resolve().parents[4]
REGISTRY_FILE = ROOT / "conventions" / "registry.json"
sys.path.insert(0, str(ROOT / "scripts"))
import conventions  # noqa: E402


class Registry:
    def __init__(self, data: dict):
        self.data = data

    @classmethod
    def load(cls, path: Optional[Path] = None) -> "Registry":
        return cls(json.loads((path or REGISTRY_FILE).read_text(encoding="utf-8")))

    @property
    def system_names(self) -> Set[str]:
        return {str(s.get("name")) for s in self.data.get("systems") or [] if s.get("name")}

    def lookup(self, repository: str) -> Optional[Dict[str, Optional[str]]]:
        """{"system", "space"} for a repository name the registry lists (owner and `.git` ignored), else None.
        Only the system and the space leave this function: working agents never see priorities."""
        answer = conventions.lookup_repo(self.data, repository)
        if answer.get("unassigned") or not answer.get("system"):
            return None
        return {"system": answer["system"], "space": answer.get("jira_space")}


RepoLookup = Callable[[str], Optional[Dict[str, Optional[str]]]]
