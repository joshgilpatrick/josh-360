#!/usr/bin/env python3
"""Gate merge-rule (JP-115): may the graph merge this repository's pull requests, or does Josh?

`agent` when the registry system that holds the repository's bare name has `merges: agent` (only josh-360 today);
`josh` otherwise, an unknown repository included. It reads the registry and nothing else.

Outcomes: agent, josh. Inputs: repo.
"""
from lib import dev_git
from lib.gate_run import execute, need


def run(inputs, deps):
    repo = need(inputs, "repo")
    rule = dev_git.merges_for(deps.registry_path, repo)
    return rule, None, "{} merges {}".format("the graph" if rule == "agent" else "Josh", repo)


if __name__ == "__main__":
    execute(run, ["repo"])
