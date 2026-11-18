# Flows

One graph file per graph, `<graph>.yaml`, following `graphs/CONVENTION.md`. The four graphs are designed in their own phase 1 tickets (JP-102, JP-103, JP-104, and the development graph's).

| File | Graph | State |
| --- | --- | --- |
| `ticket-creation.yaml` | Ticket creation | Built (JP-121), from `docs/design/ticket-creation-graph.md`; entry gate `intake-admitted`, exit gate `intake-closed`, both real scripts. Started by `graphs/intake/submit.py` |
| `triage.yaml` | Ticket triage and sign-off | Built (JP-122). Its exit gate, `no-loose-ends`, is built (JP-161) |
| `non-development.yaml` | Non-development pipeline | Built (JP-123), from `docs/design/non-development-graph.md`; every gate it uses is a real script, `ready` from JP-122 and `no-loose-ends` from JP-161 |
| `development.yaml` | Development pipeline | Built (JP-115) from `docs/superpowers/specs/2026-11-17-development-graph-design.md`; its gate scripts are real scripts (`ready` from JP-122, `no-loose-ends` from JP-161), and it uses the `wait` step |
