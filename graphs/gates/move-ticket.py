#!/usr/bin/env python3
"""Gate move-ticket (shared by every graph; built in JP-123): move a JP ticket to the status of the step's stretch.

The walker sets GRAPH_INPUT_TARGET_STATUS from the graph header's stretch for the step. The move is read back through
the shared Jira client; a ticket already there is left alone, so a run again after a crash does nothing twice. Only
JP tickets move here: the other spaces have their own workflows.

Outcomes: moved. Inputs: ticket_key, target_status.
"""
import re

from lib.gate_run import GateError, execute, need

JP_STATUSES = ("Not Started", "Ready", "Design/Planning", "In Progress", "Code Review", "Validation", "Deployed", "Done", "Cancelled")


def run(inputs, deps):
    key = need(inputs, "ticket_key")
    status = need(inputs, "target_status")
    if not re.match(r"^JP-\d+$", key):
        raise GateError("{} is not a JP ticket: this gate moves JP tickets only".format(key))
    if status not in JP_STATUSES:
        raise GateError("'{}' is not a JP status".format(status[:40]))
    deps.ticket.move(key, status)
    return "moved", None, "moved to " + status


if __name__ == "__main__":
    execute(run, ["ticket_key", "target_status"])
