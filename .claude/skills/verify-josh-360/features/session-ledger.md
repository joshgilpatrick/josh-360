# Session ledger

Every Claude Code session on Josh's laptop is recorded in the ledger without anyone doing anything: the `SessionStart` and `SessionEnd` hooks append a line to a spool, the `ledger-record` job turns the spool and the transcript's metadata into a `sessions` row and its episodes, and an agent or Josh finds the session again with `ledger/ask.py`. No message text is stored.

## Sub-features

- `ledger-spool` the two session hooks each append one spool line with only the allowed keys.
- `ledger-record` the recorder writes the session, its episode, its refs and its home from the spool and the transcript.
- `ledger-home` a branch that starts with a ticket key homes the session to that ticket.
- `ledger-ask` `ask.py find` and `ask.py home` return the recorded session, read-only.
- `ledger-no-text` no transcript message text reaches the ledger.

## How to get to it (user POV)

- Start and end any Claude Code session on the laptop. The hooks fire through `hooks/dispatch` and the job runs every 5 minutes.
- Run `python3 ledger/ask.py find --folder <path>` (or `--branch <name>`) to find the sessions that worked in a folder.
- Run `python3 ledger/ask.py home --session <id>` to see where a session belongs.

## Driving it with sandbox.py

Preconditions:

- A launched sandbox `<id>` whose `doctor` printed `"ok": true`.
- No session called `verify-sess-0001` in its ledger (true in a fresh sandbox).

- **Make a session.** Seed a made-up session on a ticket branch. Run `$S seed-session --run <id>`. It prints the working folder (`<run>/work/sample-repo`, on branch `JP-9001-sample-work`), the transcript path and the two hook input files under `<run>/payloads/`.
- **Session starts.** Fire the start hook. Run `$S hook --run <id> --event SessionStart --payload <run>/payloads/verify-sess-0001-start.json --name hook-session-start`. Exit code `0` and empty stdout: the hook never prints.
- **Session ends.** Fire the end hook. Run `$S hook --run <id> --event SessionEnd --payload <run>/payloads/verify-sess-0001-end.json --name hook-session-end`. Exit code `0`.
- **Spool written.** Read the spool back. Run `$S run --run <id> --name spool -- cat <run>/home/.josh-360/state/ledger-spool/<today>.jsonl`. Two lines for `verify-sess-0001`, events `SessionStart` and `SessionEnd`, with only the keys `at, cwd, event, reason, session_id, source, started_by, transcript_path`.
- **Recorder runs.** Run the `ledger-record` job's script. Run `$S run --run <id> --name record -- python3 ledger/record.py`. Exit code `0` and stdout counts `"sessions": 1, "episodes": 1, "homes": 1`.
- **Find it.** Ask the ledger. Run `$S run --run <id> --name ask-find -- python3 ledger/ask.py find --folder <run>/work/sample-repo`. One row with `"branch": "JP-9001-sample-work"` and `"ticket": "JP-9001"`.
- **Its home.** Run `$S run --run <id> --name ask-home -- python3 ledger/ask.py home --session verify-sess-0001`. One row with `"ticket_key": "JP-9001"` and `"method": "branch"`.
- **Stored rows.** Read the rows a second way. Run `$S ledger --run <id> --name ledger-rows "SELECT s.session_uid, s.started_by, e.episode, e.end_reason, e.branch FROM sessions s JOIN session_episodes e ON e.session_uid = s.session_uid"`. One row, `end_reason` `session-end`, branch `JP-9001-sample-work`.
- **No message text.** Search every file the ledger keeps for the seeded answer text. Run `$S run --run <id> --name no-text -- grep -rl "made-up sample answer" <run>/home/.josh-360/state`. Empty stdout and exit code `1`: no file holds it.
- **Twice is once.** Run the recorder again. Run `$S run --run <id> --name record-again -- python3 ledger/record.py`. Exit code `0` and `"sessions": 0, "episodes": 0`: nothing is recorded twice.

## Gotchas

- `$S run` passes its command straight to the process with no shell, so `<today>` and other placeholders must be typed out; a `*` glob is not expanded.
- The recorder only reads a transcript path it is given in the spool. A transcript written without the hook lines is never recorded.
- `started_by` comes from the environment by the rules in `ledger/codes.json`; in a cloud session it reads `josh`, which is expected.
- Do not run `laptop/run_jobs.py` for this feature: it also runs `ledger-summary`, which can try a model call for a thin episode.
- The `no-text` check's `grep` exit code `1` is the pass (and `$S run` then exits 1 too). Exit `0`, with a file named, means message text leaked. Search the whole `state` folder, not only `ledger.db`, so a SQLite journal file is covered.
