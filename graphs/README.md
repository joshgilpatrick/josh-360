# Graphs

The agent graphs (ticket creation, triage and sign-off, development, non-development) and the walker that says the next step.

How a graph is stored, and the rules the checker enforces: [CONVENTION.md](CONVENTION.md). Check every graph with `python3 graphs/tools/check_graph.py`. Run one with the walker: [CONVENTION.md](CONVENTION.md#the-walker).

| Folder or file | What it holds |
| --- | --- |
| `tiers.yaml` | The cheap, mid and gate tiers, mapped to a model and an effort, and the most times a role step of each tier may run (`max_runs`) |
| `flows/` | One neutral graph file per graph |
| `roles/` | Roles: `role.yaml` and `instructions.md` each |
| `agents/` | Named agents that fill a role |
| `gates/` | Gate scripts: inputs in, one outcome printed, no model |
| `contracts/` | The formats passed between steps |
| `intake/` | `submit.py`, the one command that starts a ticket creation run from a pointer ([README.md](intake/README.md)) |
| `bindings/` | Anything specific to one runner (Agent Manager first) |
| `runner/` | The graph runner (JP-117): watches Jira, starts runs, starts Agent Manager sessions for role steps ([README.md](runner/README.md)) |
| `tools/` | The checker, the walker (`walker.py`, `walker_lib/`), `compile_graphs.py` and `role_examples.py` (every role step's example result matches the step, JP-189) |
| `compiled/` | The JSON copy of each graph the walker reads, built by `compile_graphs.py` |
| `tests/` | The checker's tests and sample graphs |
