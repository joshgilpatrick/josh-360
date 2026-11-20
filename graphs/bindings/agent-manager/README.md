# Agent Manager binding

## Contents

- [What it is](#what-it-is)
- [How the runner uses it](#how-the-runner-uses-it)
- [binding.json](#bindingjson)
- [Setup notes](#setup-notes)

## What it is

`binding.py` (JP-117) starts one Agent Manager session for one graph step, reads that session's state from Agent Manager's own database, and archives it once its result is recorded. It builds the session's prompt from the walker's `run` answer alone, so it holds no graph logic, and it imports nothing of the walker, the ledger or the runner. Python 3.9, standard library only.

## How the runner uses it

The runner (`graphs/runner/`) loads the binding by the run's `runner` value, as `graphs/bindings/<runner>/binding.py`, and calls four things:

- `start(answer, marker, comments)` spawns the session and returns its handle (`am_session`, `name`, `model`, `effort`, `directory`). It raises `SpawnRefused` with one of `no-cli`, `group`, `refused`, `timeout`, `no-id`.
- `state(handle)` answers `working`, `resting`, `gone` or `unknown`. Unknown (a missing database, column or status word) changes nothing.
- `close(handle)` archives the session and says whether that worked. It never raises.
- `build_prompt` and `session_name` are what `start` uses; the first line of every prompt is the runner's marker. The prompt names each output the step declares (name, type, description, contract file) and shows the exact result skeleton, `{"outcome": ..., "outputs": {"<name>": ...}}` (JP-184): the walker refuses any other key under `outputs`.
- `move(handle, group)` files the session under another group (made first if missing) and `ensure_group(group)` makes a group; neither raises. `placed(handle)` reads the session's group and archived flag from Agent Manager's database.
- JP-173: `ticket_session_name(key, n, step)` (`JP-116(c) - Build`), `letter(n)` (a to z, then aa, ab) and `ticket_group(status)` (`josh-360/tickets/<status>`, `/` as `-`). The runner passes the chosen name and group to `start` as `session_name` and `am_group`; a group that cannot be made falls back to `binding.json`'s `group`, so a spawn never fails for it, and the runner moves the session on a later pass. A session with no ticket key keeps the old name, `<graph> - <Step> (r<run>)`.

Every `agent-manager` call runs with the folder of Claude Code first on the PATH (`JOSH360_CLAUDE_BIN`'s folder, else where `claude` is found), because a laptop job's PATH has no `~/.local/bin` and Agent Manager refuses a spawn with "claude is not installed" without it.

## binding.json

Everything specific to Agent Manager that is not code: the group (`josh-360/graph-runs`), the tool (`claude`), `prompt_max_bytes` (a longer prompt goes to `<run folder>/prompts/<step>-<attempt>.md` and the session is told to read it), `id_fields` (the fields of `spawn --json` that can hold the new session's id), `status` (which Agent Manager status words mean working, resting and gone), `archive` (the archive command's words) and `models` (a map from a model id the walker names to the id Agent Manager takes; a model not in the map is used as it is). Tests point `JOSH360_AM_BINDING_JSON` at another copy.

## Setup notes

- Each group, and every group above it, is made the first time it is needed (`create-group josh-360`, then `josh-360/tickets`, then `josh-360/tickets/In Progress`); `~/.josh-360/state/runner/groups-ready.json` lists the ones made, and a `move` that fails takes its group off the list so it is made again. This uses Josh's standing approval for group changes and nothing wider.
- Archiving uses Agent Manager's own `archive` command. Since JP-173 a ticket's session is not archived when its result is recorded: the runner keeps the ticket's newest session in view and archives the earlier ones (`graphs/runner/README.md`, "Sessions in Agent Manager"). A keyless session is still archived on its result.
- The probe on 17 November 2026 found: a job can run `agent-manager sessions --json` and `spawn` (with Claude Code's folder on the PATH); Agent Manager's database has `sessions` with `id`, `status`, `archived` and `agent_session_id`; the status words are `dead`, `finished`, `idle`, `starting`, `waiting`, `working`; the spawn reply has an `id` field. A session that has replied and stopped reads `finished`, which is filed under resting.
