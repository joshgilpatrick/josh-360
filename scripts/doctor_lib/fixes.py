"""The doctor's --fix (JP-152). Only safe, reversible steps, each one a thing Josh 360 already does by itself:

  install      runs laptop/install.py, which the follow job runs every 10 minutes: it makes the folders, creates or
               migrates the ledger (after a backup) and records the install. It writes only inside ~/.josh-360.
  hooks        runs ~/.claude/scripts/add-josh-360-hooks.py, which adds the dispatcher entries to settings.json after
               copying it to settings.json.bak-josh-360, and which `--remove` undoes.
  jira-email   writes the one-line ~/.josh-360/state/jira-email, only when --jira-email is given (a setting, not a secret).

It never installs software, signs in anywhere, deletes, moves the copy, touches launchd, Azure, Jira or git remotes, or
removes a pause. Anything else a check finds is left for the person, with its one fix step.
"""
from __future__ import annotations

import os
import re
import sys
from typing import Dict, List, Optional, Sequence

sys.dont_write_bytecode = True
from .core import Ctx, Result  # noqa: E402

EMAIL = re.compile(r"^[^@\s,;<>\"']+@[^@\s,;<>\"']+\.[^@\s,;<>\"']+$")


def plan(results: Sequence[Result], jira_email: Optional[str]) -> List[str]:
    """The fix keys to run, once each, for the checks that are not passing."""
    keys: List[str] = []
    for r in results:
        if r.fix_key and r.status in ("fail", "warn") and r.fix_key not in keys:
            if r.fix_key == "jira-email" and not jira_email:
                continue
            keys.append(r.fix_key)
    return keys


def apply(ctx: Ctx, keys: Sequence[str], jira_email: Optional[str], dry_run: bool) -> List[Dict[str, str]]:
    return [one(ctx, key, jira_email, dry_run) for key in keys]


def one(ctx: Ctx, key: str, jira_email: Optional[str], dry_run: bool) -> Dict[str, str]:
    def done(outcome: str, detail: str) -> Dict[str, str]:
        return {"fix": key, "outcome": outcome, "detail": detail}

    if key == "install":
        install = ctx.copy / "laptop" / "install.py"
        if not install.is_file():
            return done("skipped", "the laptop copy has no laptop/install.py; the first install comes from the startup list")
        if (ctx.home / "PAUSED").exists():
            return done("skipped", "installs are paused (PAUSED file); not run")
        if dry_run:
            return done("would-run", "python3 {} (it plans first and changes nothing if anything is unexpected)".format(ctx.tilde(install)))
        code, out, err = ctx.run([sys.executable, "-B", str(install)], 300)
        last = (out.strip().splitlines() or [""])[-1] if out.strip() else (err.strip().splitlines() or [""])[-1]
        return done("fixed" if code == 0 else "failed", last[:200] or "exit {}".format(code))
    if key == "hooks":
        script = ctx.user_home / ".claude" / "scripts" / "add-josh-360-hooks.py"
        if not script.is_file():
            return done("skipped", "{} is not on this laptop; git pull in ~/.claude first".format(ctx.tilde(script)))
        argv = [sys.executable, "-B", str(script), "--settings", str(ctx.settings_path)]
        if dry_run:
            return done("would-run", "{} (it backs settings.json up first)".format(" ".join(argv[1:])))
        code, out, err = ctx.run(argv, 60)
        last = (out.strip().splitlines() or [""])[-1] if out.strip() else (err.strip().splitlines() or [""])[-1]
        return done("fixed" if code == 0 else "failed", last[:200] or "exit {}".format(code))
    if key == "jira-email":
        if not jira_email or not EMAIL.match(jira_email):
            return done("skipped", "give a valid address with --jira-email")
        path = ctx.state / "jira-email"
        if path.exists():
            return done("skipped", "{} already exists; not overwritten".format(ctx.tilde(path)))
        if dry_run:
            return done("would-run", "write the address to {}".format(ctx.tilde(path)))
        ctx.state.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(jira_email + "\n", encoding="utf-8")
        os.replace(str(tmp), str(path))
        os.chmod(str(path), 0o600)
        return done("fixed", "wrote {}".format(ctx.tilde(path)))
    return done("skipped", "no such fix")
