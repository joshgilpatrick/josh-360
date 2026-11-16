# Inventory

The inventory of the work laptop and of Session Atlas and action-triage, with a verdict per item: keep, migrate, build new or dismantle (JP-96, JP-97).

- `laptop.md`: every job, hook, plugin, memory mechanism, data store, agent definition and skill on the work laptop, with a verdict, the dismantling plan and the questions for JP-106.
- `starting-figures.md`: the numbers later change is measured against, each with its date range and command.

`scripts/check.py` checks that every inventory row has exactly one verdict and a reason, and that every figure states its date range and command. `scripts/laptop_inventory.py` refreshes both files from the laptop, read-only.
