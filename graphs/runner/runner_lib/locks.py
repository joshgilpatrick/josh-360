"""`flock` locks, so a killed process never leaves one behind (JP-117)."""
from __future__ import annotations

import contextlib
import fcntl
import os
from pathlib import Path


class Held(Exception):
    """Another process has the lock."""


@contextlib.contextmanager
def held(path: Path):
    """Take a non-blocking exclusive lock on `path` (created when missing); raise Held when another process has it."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(path), os.O_RDWR | os.O_CREAT, 0o644)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise Held(str(path))
        try:
            yield
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)


def is_held(path: Path) -> bool:
    try:
        with held(path):
            return False
    except Held:
        return True
    except OSError:
        return False
