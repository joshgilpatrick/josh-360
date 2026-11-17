# Gate scripts

`<gate>.py` or `<gate>.sh`. Inputs arrive as `GRAPH_INPUT_<NAME>` environment variables; the script prints one JSON line with `outcome`, and optionally `outputs` and `summary`. No model. Only gate scripts move tickets or set labels. See `graphs/CONVENTION.md`, "Gate scripts".

## How the non-development gates are written (JP-123)

Each is a `run(inputs, deps)` function and a four-line `__main__` that calls `lib/gate_run.execute`. `run` returns `(outcome, outputs, summary)` and reaches Jira, the desk mailer and the draft tool only through `deps`, so a test calls it with fakes and no network; a gate that needs no Jira (`gap-check` when it is clear, `sign-off-rule`) never builds a client. A gate that cannot finish raises `GateError`, which exits 1: the walker stops the run and never retries it. Every comment passes the patient-data screen (`lib/patient_data.py`) before it is written, and a gate run again after a crash does not repeat a comment its newest comment already says.

| File in `lib/` | What it holds |
| --- | --- |
| `gate_run.py` | `execute`, `GateError`, `Deps`, `say` (screened comment, once) |
| `ticket_port.py` | `JiraPort` (the five ticket calls over `lib/jira.py`) and the Outlook draft |
| `ticket_text.py` | a ticket's sections, search words, quote matching |
| `evidence.py` | the evidence file's front block, with the standard library only |
| `artifacts.py` | where a deliverable may live |
| `nondev_copy.py` | the graph's exact comment and email copy |
