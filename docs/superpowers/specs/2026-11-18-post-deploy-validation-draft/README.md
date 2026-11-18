# Draft validation graph (JP-164)

## Contents

- [What this folder is](#what-this-folder-is)
- [Checking it](#checking-it)
- [What is in it](#what-is-in-it)

## What this folder is

The draft of the validation graph designed in [the post-deploy validation spec](../2026-11-18-post-deploy-validation-design.md). It is a design drawing, not a live graph: it sits outside `graphs/`, so the walker and the graph runner never see it. The build ticket moves the graph file to `graphs/flows/validation.yaml`, writes the gate scripts for real in `graphs/gates/`, and deletes this folder.

## Checking it

```bash
python3 graphs/tools/check_graph.py --root docs/superpowers/specs/2026-11-18-post-deploy-validation-draft
```

The folder is laid out as a parts folder (`flows/`, `gates/`, `contracts/`, `tiers.yaml`) because the checker needs every gate script and contract a graph names to exist under one root.

## What is in it

| Path | What it is |
| --- | --- |
| `flows/validation.yaml` | The draft graph: eleven steps, none of which uses a model |
| `gates/*.py` | One placeholder per gate script the graph names. Each holds the script's contract (inputs, outcomes, outputs, what it may write) and exits with "not built" if run. `no-loose-ends.py` stands in for the real exit gate in `graphs/gates/`. |
| `contracts/validation-plan.md`, `contracts/watch-result.md` | The two formats passed between steps |
| `tiers.yaml` | A copy of `graphs/tiers.yaml`, which the checker reads from the root. The graph has no role step, so no tier is used. |
