# Flows

One graph file per graph, `<graph>.yaml`, following `graphs/CONVENTION.md`. The four graphs are designed in their own phase 1 tickets (JP-102, JP-103, JP-104, and the development graph's).

| File | Graph | State |
| --- | --- | --- |
| `triage.yaml` | Ticket triage and sign-off | Built (JP-122). `no-loose-ends`, its exit gate, is still JP-109's stub |
| `non-development.yaml` | Non-development pipeline | Built (JP-123), from `docs/design/non-development-graph.md`; every gate it owns is a real script, and `ready` and `no-loose-ends` wait for JP-122 and JP-109 |
| `development.yaml` | Development pipeline | Built (JP-115) from `docs/superpowers/specs/2026-11-17-development-graph-design.md`; its gate scripts are real scripts except `ready` (JP-122) and `no-loose-ends` (JP-109), and it uses the `wait` step |
