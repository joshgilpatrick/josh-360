"""Puts the repository root on sys.path, so `import ledger.x`, `import laptop.common` and the shared patient-data
screen resolve whether a ledger file runs as a script (a job, a hook, a command) or is imported by a test.

Import this first in any file that is run directly. Python 3.9, standard library only.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GATES = ROOT / "graphs" / "gates"

for _p in (str(ROOT), str(GATES)):
    if _p not in sys.path:
        sys.path.insert(0, _p)
