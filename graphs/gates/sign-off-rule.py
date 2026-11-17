#!/usr/bin/env python3
"""Gate sign-off-rule (JP-104 design, built in JP-123): does this run wait for Josh's sign-off? No model, no Jira.

`emailed` when origin is email: the answer is already in Josh's inbox, the ticket closes, and his reply to that email
reopens it. `ask_josh` for every other ticket. Josh's decision, 16 November 2026.

Outcomes: ask_josh, emailed. Inputs: origin.
"""
import sys

from lib.gate_run import execute


def run(inputs, deps):
    if (inputs.get("origin") or "ticket").strip().lower() == "email":
        return "emailed", None, "emailed ask: closes without sign-off"
    return "ask_josh", None, "waits for Josh's sign-off"


if __name__ == "__main__":
    execute(run, ["origin"])
