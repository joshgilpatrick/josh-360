"""How a gate script reads its inputs and prints its result (the agreed form, JP-114; see the walker design, C2).

Python 3.9, standard library only. A gate script is a few lines:

    from lib.gate_io import read_inputs, finish
    inputs = read_inputs(["ticket_key"])
    finish("pass", summary="checked " + inputs["ticket_key"])

The walker runs the script, reads one JSON line from it, and treats any non-zero exit as a failed gate.
"""
from __future__ import annotations

import json
import os
import sys
from typing import Dict, List, Mapping, NoReturn, Optional


def read_input(name: str, environ: Optional[Mapping[str, str]] = None) -> Optional[str]:
    """The input's value, or None when it is not set."""
    env = os.environ if environ is None else environ
    return env.get("GRAPH_INPUT_" + name.upper())


def read_inputs(names: List[str], environ: Optional[Mapping[str, str]] = None) -> Dict[str, Optional[str]]:
    return {name: read_input(name, environ) for name in names}


def finish(outcome: str, outputs: Optional[dict] = None, summary: Optional[str] = None) -> NoReturn:
    """Print the one JSON line and exit 0."""
    doc = {"outcome": outcome}
    if outputs:
        doc["outputs"] = outputs
    if summary:
        doc["summary"] = summary
    sys.stdout.write(json.dumps(doc) + "\n")
    sys.exit(0)


def fail(message: str) -> NoReturn:
    """Say why on standard error and exit 1."""
    sys.stderr.write(message.rstrip() + "\n")
    sys.exit(1)
