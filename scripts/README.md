# Scripts

The repository's own tools: the checks CI runs, the platform doctor, and the scripts behind several laptop jobs. Code that runs on the laptop uses Python 3.9 and the standard library only (`scripts/check.py` parses it as 3.9).

## Contents

- [Checks and reference files](#checks-and-reference-files)
- [The platform doctor](#the-platform-doctor)
- [Laptop jobs and their helpers](#laptop-jobs-and-their-helpers)

## Checks and reference files

| Script | What it does |
| --- | --- |
| `check.py` | Every repository check, then every test (`--fast` skips the tests). CI runs it as the `suite` job. Its docstring lists each check. |
| `docs_check.py` | The documentation checks (JP-158): every `#anchor` and relative link in a Markdown file resolves, every top-level folder has a README, the roles and agents READMEs list every folder, and the `verify-josh-360` skill and its feature map keep their shape. Run by `check.py`. |
| `conventions.py` | Checks and reads `conventions/registry.yaml` and `priorities.yaml` (`check`, `lookup --folder <path>` or `--repo <name>`, `priority`, `export-json`). |
| `decisions.py` | The per-ticket decision files in `docs/decisions/` (`list [--ticket JP-n]`, `check`). |
| `feature_tree.py` | The JP-143 feature tree: `check`, and `build` the review page after editing `docs/design/feature-tree/tree.yaml`. |
| `architecture_page.py` | The JP-144 architecture page: `check`, and `build` after editing the feature tree or `docs/design/architecture/`. |

## The platform doctor

`doctor.py` (JP-152) checks every part of Josh 360 on the laptop and prints the one step that fixes each problem; `doctor_lib/` holds the checks by group and the safe fixes; `doctor_job.py` runs it daily as the `doctor` job. Reference: `docs/platform-doctor.md`.

## Laptop jobs and their helpers

Each `*_job.py` is the script a `jobs.yaml` entry runs; the others are run by hand on the laptop.

| Script | What it does |
| --- | --- |
| `laptop_inventory.py`, `laptop_figures.py` | The read-only laptop inventory and its starting figures (JP-96). |
| `laptop_inventory_job.py` | Runs the inventory once as the `inventory` job. |
| `launchd_check_job.py` | Runs `laptop/check_jobs.py` daily as the `launchd-check` job (JP-119). |
| `retire_focus_dashboard.py`, `retire_session_atlas.py`, `retire_leftover_jobs.py` | One-time jobs that switch an old launchd job off and archive it (JP-100, JP-111, JP-119). |
| `restore_retired_job.py` | Puts a job switched off by `retire-leftover-jobs` back, from its archive folder. |
| `console.py`, `console_lib/` | The live console (JP-185): what Josh 360 is doing, read from the ledger and the logs, in one colored stream. `--once` prints and exits. |
| `console_terminal_job.py` | Keeps one Agent Manager terminal named `console` running the console, as the `console-terminal` job (JP-185). |
| `atlas_service.py` | Keeps the headless Session Atlas running, as the hourly `session-atlas-service` job (JP-111). It is the one launchd installer Josh 360 ships, until the phase 1 close (`docs/phase-1-close-checklist.md`). |
