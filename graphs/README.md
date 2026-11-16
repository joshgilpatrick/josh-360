# Graphs

The agent graphs (ticket creation, triage and sign-off, development, non-development) and the walker that says the next step.

How a graph is stored, and the rules the checker enforces: [CONVENTION.md](CONVENTION.md). Check every graph with `python3 graphs/tools/check_graph.py`.

| Folder or file | What it holds |
| --- | --- |
| `tiers.yaml` | The cheap, mid and gate tiers, mapped to a model and an effort |
| `flows/` | One neutral graph file per graph |
| `roles/` | Roles: `role.yaml` and `instructions.md` each |
| `agents/` | Named agents that fill a role |
| `gates/` | Gate scripts: inputs in, one outcome printed, no model |
| `contracts/` | The formats passed between steps |
| `bindings/` | Anything specific to one runner (Agent Manager first) |
| `tools/` | The checker, and the walker later |
| `tests/` | The checker's tests and sample graphs |
