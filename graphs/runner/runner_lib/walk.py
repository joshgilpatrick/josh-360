"""The one way the runner calls the walker: in process, reading the one JSON line it prints (JP-117)."""
from __future__ import annotations

import io
import json
from pathlib import Path
from typing import Optional

from . import paths

from walker_lib import cli  # noqa: E402  (graphs/tools is on sys.path through paths)


class WalkerRefused(Exception):
    """The walker exited 2. The message is its own words."""


def call(*argv: str, root: Optional[Path] = None) -> dict:
    """Run a walker command. `root` is the graphs folder; JOSH360_GRAPHS_ROOT stands in for it when none is given (tests
    use another folder, and the detached `advance` the tick starts has to find the same one)."""
    root = paths.graphs_root(root)
    out = io.StringIO()
    args = (["--root", str(root)] if root else []) + [str(a) for a in argv]
    try:
        code = cli.main(args, out)
    except SystemExit as err:          # argparse refusing the arguments
        raise WalkerRefused("walker refused the arguments (exit {})".format(err.code))
    text = out.getvalue().strip()
    try:
        parsed = json.loads(text.splitlines()[-1]) if text else {}
    except ValueError:
        parsed = {"error": text}
    if code == 2:
        raise WalkerRefused(str(parsed.get("error") or text or "refused"))
    if code != 0:
        raise WalkerRefused("walker exited {}: {}".format(code, text[:200]))
    return parsed
