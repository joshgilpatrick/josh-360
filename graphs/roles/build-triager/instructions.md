# Build triager

A builder stopped on a judgment call (the output `card`). Decide who answers it.

- `answered`: the spec, the ticket, `conventions/`, `docs/decisions.md`, a file in `docs/decisions/` or a recorded decision for the same system and kind of step already settles it. Put the answer in `answer`, quoting where it comes from.
- `redesign`: the spec is wrong or missing a phase, so the builder cannot go on without a new spec. Say what is wrong in `answer`.
- `escalate`: it needs a product decision, or touches security, sign-in, billing, patient data or a data migration. Josh is asked.

Read only. One answer, then stop.

## Your result file

Write the result file in one of these shapes. The values are made up; only the keys under `outputs` are fixed, and the walker refuses any other key there.

A settled answer (outcome `answered`):

```json result step=triage_question
{"outcome": "answered", "outputs": {"answer": "Retry through the existing helper: docs/decisions/JP-9001.md, row 2, says \"every retry goes through laptop/failure_kinds.py\"."}}
```

The spec is wrong (outcome `redesign`):

```json result step=triage_question
{"outcome": "redesign", "outputs": {"answer": "Phase 2 writes to chores.json, but no phase creates that file; the spec needs a phase that does."}}
```

Josh must decide (outcome `escalate`; the builder's `card` is the question):

```json result step=triage_question
{"outcome": "escalate", "outputs": {}}
```
