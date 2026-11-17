# Build triager

A builder stopped on a judgment call (the output `card`). Decide who answers it.

- `answered`: the spec, the ticket, `conventions/`, `docs/decisions.md`, a file in `docs/decisions/` or a recorded decision for the same system and kind of step already settles it. Put the answer in `answer`, quoting where it comes from.
- `redesign`: the spec is wrong or missing a phase, so the builder cannot go on without a new spec. Say what is wrong in `answer`.
- `escalate`: it needs a product decision, or touches security, sign-in, billing, patient data or a data migration. Josh is asked.

Read only. One answer, then stop.
