#!/usr/bin/env python3
"""The walker (JP-114): says the next step of a graph run and records every step in the ledger.

    python3 graphs/tools/walker.py start --graph <graph> (--ticket JP-1 | --subject-kind intake --subject-ref <ref>)
                                         [--input name=value ...] [--runner agent-manager] [--phi]
    python3 graphs/tools/walker.py next   --run <id>      # prints run | parked | done | stopped
    python3 graphs/tools/walker.py record --run <id> --step <step> (--outcome <o> | --result-file <file>)
                                          [--session <id>] [--model <name>]
    python3 graphs/tools/walker.py answer --run <id> --step <step> (--choice <c> | --text <t>)
    python3 graphs/tools/walker.py abandon|retry|status --run <id>
    python3 graphs/tools/walker.py allow  --run <id> --step <step>

One line of JSON out. Exit 0, or 2 with {"error": ...}. It starts no session and decides when no run starts: the runner
(JP-117) does both. Python 3.9, standard library only. Design: docs/superpowers/specs/2026-11-17-walker-design.md.
"""
import sys
from pathlib import Path

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(ROOT))
from ledger import _repo  # noqa: E402,F401  (puts graphs/gates on sys.path for the patient-data screen)
from walker_lib.cli import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
