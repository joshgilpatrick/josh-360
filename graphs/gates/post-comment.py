#!/usr/bin/env python3
"""DRAFT effect: post-comment. Used by the walker (JP-114), not named by any graph step.

    post-comment.py --ticket KEY --body-file FILE

Posts the file's text as a comment on the ticket (the walker posts Josh's typed answer this way, after the
patient-data screen for outside writes has passed). Until the shared Jira library exists (graphs/gates/lib/jira.py)
it refuses, and the walker treats a refusal as a warning.
"""
import sys

sys.exit("post-comment: not built yet (waits for the shared Jira library, JP-121 to JP-123)")
