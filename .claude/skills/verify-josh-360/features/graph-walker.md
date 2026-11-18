# Graph walker

The walker carries a piece of work through a graph one step at a time: it runs gate scripts itself, hands each role step to whoever plays it (an Agent Manager session through the graph runner, or a person at the command line), records every step in the ledger, and says when the run has ended. The ticket creation graph starts from one loose request through `graphs/intake/submit.py` (JP-114, JP-121).

## Sub-features

- `walker-intake-start` `submit.py` starts a ticket creation run and prints its run id; the entry gate `intake-admitted` lets it in.
- `walker-next-role` `next` hands out a role step with its brief, allowed outcomes and result file.
- `walker-record` `record --result-file` accepts a declared outcome and outputs.
- `walker-gate` the next `next` runs the following gate step itself and follows its outcome.
- `walker-end` a run that reaches an end state reports `done` with its end and score, and `status` shows every step.
- `walker-ledger` the run, its steps and its end are rows in the ledger.
- `walker-refuse` a graph whose entry gate needs Jira refuses to start without credentials, with a clear error.

## How to get to it (user POV)

- Say yes to a ticket offer: the agent runs `python3 ~/.josh-360/repo/graphs/intake/submit.py --source session --ref <session id>`.
- By hand: `python3 graphs/tools/walker.py start --graph <graph> --ticket <KEY>`, then `next`, `record`, `answer`, `status`, `abandon` with `--run <id>`.
- On the laptop the `graph-runner` job does the `next`/`record` loop for Ready tickets carrying the `ready-to-run` label (`graphs/runner/README.md`).

## Driving it with sandbox.py

Preconditions:

- A launched sandbox `<id>` whose `doctor` printed `"ok": true`.
- No Jira credentials in the sandbox (the helper strips them), so only the ticket creation graph's first stretch can run.

- **Start from intake.** Run `$S run --run <id> --name walker-submit -- python3 graphs/intake/submit.py --source session --ref verify-sess-0001`. Exit code `0`; stdout is one run id, `r-<12 hex>`.
- **First step.** Run `$S run --run <id> --name walker-next-1 -- python3 graphs/tools/walker.py next --run <run id>`. JSON with `"action": "run"`, `"kind": "role"`, `"step": "read_intake"`, `"role": "intake-reader"`, `"outcomes": ["recorded"]`, a `result_file` and a `work_dir` under `<run>/home/.josh-360/runs/<run id>/`.
- **Play the role.** Write a made-up intake record to `<work_dir>/intake-record.json` naming a personal repository, for example `{"source": "session", "source_ref": "verify-sess-0001", "requester": "Josh", "request": "Add a made-up chores page to the household app.", "deliverable": {"value": "a merged pull request in family_os", "basis": "inferred"}, "ticket_type": "Story", "work_kind": "code", "weight": "light", "repository": {"value": "family_os", "basis": "stated"}, "search_terms": ["chores page"], "unresolved": [], "contains_patient_data": false}`, then write `{"outcome": "recorded", "outputs": {"intake_record": "<work_dir>/intake-record.json"}}` to the `result_file`.
- **Record it.** Run `$S run --run <id> --name walker-record -- python3 graphs/tools/walker.py record --run <run id> --step read_intake --result-file <result_file>`. JSON `"recorded": true`, `"outcome": "recorded"`.
- **Gate and end.** Run `$S run --run <id> --name walker-next-2 -- python3 graphs/tools/walker.py next --run <run id>`. The walker runs the `route-ticket` gate, which finds `family_os` tracked in Linear, and prints `{"action": "done", "end": "route.personal", "score": "neutral"}`.
- **Status.** Run `$S run --run <id> --name walker-status -- python3 graphs/tools/walker.py status --run <run id>`. `"ended": "route.personal"` and steps `_entry` (pass), `read_intake` (recorded), `route` (personal).
- **Ledger.** Run `$S ledger --run <id> --name walker-rows "SELECT g.run_id, g.graph_id, g.subject_kind, e.end_name, e.score FROM graph_runs g LEFT JOIN run_ends e ON e.run_id = g.run_id"`. One row: `ticket-creation`, `intake`, `route.personal`, `neutral`.
- **Refusal.** Run `$S run --run <id> --name walker-refuse -- python3 graphs/tools/walker.py start --graph non-development --ticket JP-9001 --runner cli`. Exit code `2` and `{"error": "the entry gate 'ready' did not admit the run: gate 'ready' failed (1): Jira credentials missing: ..."}`; no new run folder is made.

## Gotchas

- The walker prints JSON either way. A refusal exits `2` with an `error` key; read the key, since `submit.py` prints its refusal as one line on stderr instead.
- Only a repository tracked in Linear (`family_os` today) ends the run at `route`. Any other route goes on to `find_duplicates`, which reads Jira and fails in the sandbox.
- The triage, development and non-development graphs read Jira in their entry gate, and their exit gate `no-loose-ends` is a stub that refuses to run, so none can finish anywhere yet. On the laptop, drive their first steps against a made-up JP ticket and cancel it afterwards.
- The walker reads `graphs/compiled/`, not the YAML. After changing a graph, run `python3 graphs/tools/compile_graphs.py` and commit before launching.
- `submit.py` refuses a second open run for the same `--ref` (exit `2`, `the entry gate 'intake-admitted' did not admit the run: it printed 'refused'`), even after the first has ended. Use a new `--ref` for each run.
- A result file outside the step's `results/` path, or an outcome the step does not declare, is refused.
