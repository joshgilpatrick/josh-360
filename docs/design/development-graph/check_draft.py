#!/usr/bin/env python3
"""Check the development graph draft with today's checker (JP-115 design).

The draft uses the proposed `wait` step kind, which the checker does not know yet. This script copies the draft,
turns each `wait: <script>` into `gate: <script>` (a wait step is a gate the walker calls again until it stops
saying pending), and runs graphs/tools/check_graph.py on the copy. Every other rule is checked as it stands.
Delete this file when the JP-115 build moves the draft to graphs/flows/.
"""
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
DRAFT = Path(__file__).resolve().parent / "development.yaml"

text = DRAFT.read_text(encoding="utf-8")
waits = [line.split(":", 1)[1].strip() for line in text.splitlines() if line.strip().startswith("wait:")]
copy = "\n".join(line.replace("wait:", "gate:", 1) if line.strip().startswith("wait:") else line
                 for line in text.splitlines()) + "\n"
with tempfile.TemporaryDirectory() as tmp:
    path = Path(tmp) / "development.yaml"
    path.write_text(copy, encoding="utf-8")
    print(f"wait steps read as gate steps: {', '.join(waits)}")
    result = subprocess.run([sys.executable, str(ROOT / "graphs/tools/check_graph.py"), str(path)])
sys.exit(result.returncode)
