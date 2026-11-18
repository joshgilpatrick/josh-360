# Flows

One graph file per graph, `<graph>.yaml`, following `graphs/CONVENTION.md`. The four graphs are designed in their own phase 1 tickets (JP-102, JP-103, JP-104, and the development graph's).

| File | Graph | State |
| --- | --- | --- |
| `ticket-creation.yaml` | Ticket creation | Built (JP-121), from `docs/design/ticket-creation-graph.md`; entry gate `intake-admitted`, exit gate `intake-closed`, both real scripts. Started by `graphs/intake/submit.py` |
| `triage.yaml` | Ticket triage and sign-off | Built (JP-122). `no-loose-ends`, its exit gate, is still JP-109's stub |
| `non-development.yaml` | Non-development pipeline | Built (JP-123), from `docs/design/non-development-graph.md`; every gate it owns is a real script, and `ready` is built (JP-122); `no-loose-ends` waits for JP-109 |
| `development.yaml` | Development pipeline | Built (JP-115) from `docs/superpowers/specs/2026-11-17-development-graph-design.md`; its gate scripts are real scripts except `no-loose-ends` (JP-109), and it uses the `wait` step |
