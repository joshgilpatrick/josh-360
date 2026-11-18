---
name: verify-josh-360
description: "Drive and prove Josh 360 (josh-360) the way Josh's laptop uses it: its Claude Code hooks, background jobs, ledger, platform doctor, laptop follow-and-install, and graph walker, in a throwaway sandbox laptop with its own HOME and a local stand-in for GitHub. Use when a change to ledger/, hooks/, laptop/, scripts/doctor*, graphs/ or jobs.yaml needs to be shown working end to end, not just in unit tests, or to prove a feature in features/."
---

# Verify Josh 360

Josh 360 has no screen. What Josh touches is a set of command-line tools and background parts on his laptop: Claude Code hooks that fire in every session, jobs that run every few minutes, the ledger they write, the platform doctor, and the graph walker. They all read `~/.josh-360` and `~/.claude`, and the job runner pushes reports to its copy's `origin`. So driving them for real means building a fake laptop first. `scripts/sandbox.py` (in this skill's folder) does that, and every step below goes through it.

The feature recipes are in [`features/README.md`](features/README.md). Read it before driving anything.

## Contents

- [Launch](#launch)
- [Doctor](#doctor)
- [Drive](#drive)
- [Evidence](#evidence)
- [Cleanup](#cleanup)
- [Helpers](#helpers)
- [Keeping this skill honest](#keeping-this-skill-honest)

## Launch

Run every command from the root of a josh-360 checkout. Set `S=.claude/skills/verify-josh-360/scripts/sandbox.py`.

1. Install the one dependency once: `pip install -r requirements.txt` (PyYAML).
2. Commit what you want to verify. The sandbox drives the checkout's committed `HEAD`, not the working tree. `launch` refuses a dirty checkout unless you pass `--allow-dirty`, and then it still drives `HEAD`.
3. Launch one sandbox per run, with the evidence folder named after the ticket:

   ```bash
   $S launch --run <run-id> --evidence docs/proof/$(date +%F)/<KEY>/verify-josh-360
   ```

   It creates `/tmp/verify-josh-360/<run-id>/` (`$VERIFY_JOSH360_ROOT` moves it, `$TMPDIR` is honoured) holding:

   - `origin.git`, a bare repo standing in for GitHub, whose `main` is the checkout's `HEAD`;
   - `home/`, the `HOME` for every command, with `~/.josh-360/repo` cloned from `origin.git` at `main`, an empty `~/.claude/settings.json`, and claude-harness's `~/.claude/scripts/add-josh-360-hooks.py` copied in when it can find claude-harness (`--harness <dir>`, else the real `~/.claude`, else `../claude-harness` beside the checkout);
   - the marker file `.verify-josh-360`, which every other subcommand reads.

   It then runs the real install, `laptop/install.py --json`, from the sandbox copy.

**Ready when** `launch` prints `"ok": true` and its `install_tail` ends with `{"result": "passed", ...}`. Exit 1 means the install found a problem; read `launch-install.json` in the evidence folder.

Two sandboxes never share state: each has its own run folder, `HOME` and `origin.git`, so runs can sit side by side. The real `~/.josh-360`, `~/.claude` and GitHub are never touched, and no Jira, GitHub, Azure or Anthropic credential is passed in (`SECRET_PREFIXES` in the helper). Never drive the real `~/.josh-360/repo` with this skill.

## Doctor

```bash
$S doctor --run <run-id>
```

It runs the platform doctor (`scripts/doctor.py --json`, JP-152) inside the sandbox and passes only when the sandbox is worth driving:

- the copy's `origin` is the sandbox's `origin.git`, not GitHub;
- the copy is at the sandbox's `main`;
- these doctor checks pass: `install.home`, `install.copy`, `install.runs-from-copy`, `install.installed-commit`, `install.jobs-file`, `install.not-paused`, `hooks.files`, `data.ledger`, `data.ledger-shape`, `graphs.compiled`, `graphs.walker`.

Other doctor checks fail or warn in a fresh sandbox by design (no follow run yet, no hook entries until `doctor --fix`, no Jira email, no Azure, no launchd off a Mac). The full report is saved as `doctor.json`. Run the doctor first, and again whenever anything looks off.

## Drive

Drive each feature through the path Josh's laptop uses, with these subcommands:

| What you do | Command |
| --- | --- |
| Run any josh-360 command on the sandbox laptop (cwd is `~/.josh-360/repo`) | `$S run --run <id> --name <step> -- python3 <script> <args>` |
| Fire a Claude Code hook event the way Claude Code does (stdin JSON into `hooks/dispatch <Event>`) | `$S hook --run <id> --event <Event> --payload <file.json> --name <step>` |
| Make a made-up session: a git folder on a branch, a transcript with no real text, and its `SessionStart`/`SessionEnd` hook inputs | `$S seed-session --run <id> [--session <sid>] [--branch <name>] [--folder <name>]` |
| Merge a made-up commit to the sandbox's `main`, as a GitHub merge would | `$S advance-main --run <id>` |
| Read the ledger back, read-only (`mode=ro`) | `$S ledger --run <id> --name <step> "<SELECT ...>"` |
| Print the sandbox's paths and environment | `$S env --run <id>` |

Stable handles to assert on: JSON keys and exit codes, never wording. The recorder prints `{"sessions": n, "episodes": n, ...}`; `ledger/ask.py` prints `{"query": ..., "rows": [...]}`; hooks print `hookSpecificOutput.additionalContext` JSON or nothing; the doctor prints `checks[].id` and `checks[].status`; `laptop/status.py show` prints `status.json` from the `laptop-status` branch.

The background jobs run on the laptop every few minutes. In the sandbox, run the job's own script (`python3 ledger/record.py` is the `ledger-record` job) or the whole runner (`python3 laptop/run_jobs.py`, which runs every due job, `follow` first). The feature files say which.

## Evidence

Every `run`, `hook`, `seed-session`, `ledger`, `advance-main` and `doctor` call given `--name` (doctor always) saves one JSON file in the evidence folder: the command, its working folder, the time, the exit code, stdout, stderr and, for hooks, the stdin payload. The evidence folder is outside the run folder, so cleanup cannot remove it. Commit it under `docs/proof/YYYY-MM-DD/<KEY>/` with a short `README.md` that maps each step to its file.

Proof standards:

- Exercise the real user path: the hook through `hooks/dispatch`, the job through its script or `run_jobs.py`, the command Josh types. Never call internal functions or test helpers.
- Capture the action and the resulting state, not just the final output: save the hook's output and the spool line it wrote; save the recorder's counts and a `ledger` read of the rows.
- Verify side effects with a second, read-only view: a `ledger` query, a file listing, a `git log` of `origin.git`.
- Mocks only at the boundary the sandbox already draws: `origin.git` stands in for GitHub. Jira, Azure and model calls are absent, not faked; a feature that needs them says so and is proved on the laptop.
- Do not trust a mode by its name. `run_jobs.py --help` is not a help flag: the runner ignores every argument except `--list` and runs every due job, pushing reports to `origin`. Inside the sandbox that `origin` is `origin.git`; anywhere else it is GitHub.
- No patient data. Seeded sessions hold made-up text only.

## Cleanup

```bash
$S cleanup --run <run-id>
```

It removes only a run folder that carries this helper's marker and sits inside `/tmp/verify-josh-360/`, and refuses when the evidence folder is inside it. Nothing the sandbox runs is left running (every command is waited for), so nothing is killed. It prints the evidence files that remain; it exits 1 if the evidence folder is empty, so a cleanup that ate the proof fails loudly. After a failed attempt, run cleanup too, then launch a fresh run id.

## Helpers

`scripts/sandbox.py` is the only helper. It is executable, Python 3.9 or newer, standard library only, so it runs in a cloud session and on the laptop alike. `$S --help` and `$S <subcommand> --help` list the flags. Every subcommand prints JSON and exits 0 on success, 1 when a check fails, 2 for bad input.

## Keeping this skill honest

The feature map is the maintained source for proving Josh 360's user-facing features. When a feature changes, update its file in `features/` in the same pull request. For a periodic pass over the whole map, use claude-harness's `maintain-verification-skill` (`/maintain-verification-skill`); no cadence is set, and Josh sets one only if he asks.
