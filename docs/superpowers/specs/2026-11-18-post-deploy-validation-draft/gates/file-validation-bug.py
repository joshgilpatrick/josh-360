#!/usr/bin/env python3
"""DRAFT for JP-164: the contract of a gate script that is not built yet.

Step file_bug. Writes to Josh's Jira space: one Bug, one link, one comment.

Creates a Bug in Not Started from the fixed template in the spec ("The Bug a failed watch files"), linked to the
ticket, labelled `validation-failure` and the ticket's system label. If a Bug with that label is already open and
linked to the ticket, it is used and nothing is created. Comments on the ticket naming the Bug.
The patient-data screen runs over every field before the write.
Inputs: ticket_key, failed, evidence. Outcomes: filed. Outputs: bug_key.

Design: docs/superpowers/specs/2026-11-18-post-deploy-validation-design.md.
"""
import sys

if __name__ == "__main__":
    sys.exit("draft: file-validation-bug is not built (JP-164)")
