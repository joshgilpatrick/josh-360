#!/bin/bash
# PostToolUse hook (matcher: Bash). Records a cost-ledger link when a successful Jira transition or
# comment names an issue key. Cheap prefilter: Node only starts when the command mentions Jira.
# Always exits 0 so it can never block or fail a Bash call.

input="$(cat)"

case "$input" in
  *"jira workitem"*)
    printf '%s' "$input" | node --disable-warning=ExperimentalWarning \
      "$(dirname "$0")/../src/costledger/jira-hook-cli.ts" >/dev/null 2>&1
    ;;
esac

exit 0
