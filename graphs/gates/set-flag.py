#!/usr/bin/env python3
"""DRAFT effect: set-flag. Used by the walker (JP-114), not named by any graph step.

    set-flag.py --ticket KEY --on|--off

Puts the Jira flag on the ticket when a question for Josh is parked, and takes it off when he answers. Exit 0 only when
Jira confirms the change on read-back. Until the shared Jira library exists (graphs/gates/lib/jira.py, built by the
first of JP-121, JP-122 and JP-123 to land) it refuses, and the walker treats a refusal as a warning.
"""
import sys

sys.exit("set-flag: not built yet (waits for the shared Jira library, JP-121 to JP-123)")
