---
name: platform-doctor
description: "Use when Josh asks whether Josh 360 is working, what is live on his laptop, or to check hooks, jobs, databases, services, the Azure backup or the Jira settings. Runs the read-only platform doctor (scripts/doctor.py) and acts on its JSON."
---

# Platform doctor

The doctor checks every part of Josh 360 on the laptop and prints one line per check with the one step that fixes it. Reference: `docs/platform-doctor.md`.

## On the laptop (Josh's own Claude session)

1. Run `python3 ~/.josh-360/repo/scripts/doctor.py --json` (use `/usr/bin/python3` if `python3` is older than 3.9). It is read-only: it changes nothing and prints no token, email address or row text.
2. Read `summary`, then every check whose `status` is `fail` or `warn`. Tell Josh in plain words what is wrong and give the check's `fix` step. A `skip` is not a problem.
3. If a check has `auto_fix` set, the fix is safe and reversible: offer `python3 ~/.josh-360/repo/scripts/doctor.py --fix --dry-run` first, then `--fix` once Josh agrees. `--fix` never signs in, installs software, deletes, removes a pause or touches launchd, Azure, Jira or git remotes. Never edit `~/.claude/settings.json` by hand to fix a hook: use `--fix` (it keeps a backup).
4. List the `manual` checks (what only Josh can see, from the proof pages) after the results. They are not failures.
5. Run the doctor again after any fix and report the new summary. Add `--online` to also ask GitHub and Jira, `--only <group>` to run one group.

## From the cloud

The laptop runs the doctor daily as the `doctor` job. Read its last report with `python3 laptop/status.py show doctor` from any clone (same fields as `--json`, plus its time). The report is only as new as the last daily run; ask Josh to run the command above for a fresh one. A cloud session cannot run the doctor against the laptop.

## Rules

- Never paste the output into a ticket without checking it holds no patient data (it holds none by design: names, counts and paths only).
- A new part of the platform (a job, hook, database or service) adds its own check in `scripts/doctor_lib/`, with a test in `tests/test_doctor.py`; see `docs/platform-doctor.md`.
