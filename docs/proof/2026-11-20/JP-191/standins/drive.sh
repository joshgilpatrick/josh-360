#!/bin/bash
# usage: drive.sh <name> <command...>  (runs it in the sandbox with the stand-in environment; prints exit, stdout, stderr tail)
S=.claude/skills/verify-josh-360/scripts/sandbox.py; R=/tmp/verify-josh-360/jp191; SI=$R/standin; C=$R/home/.josh-360/repo
name=$1; shift
$S run --run jp191 --name "$name" -- env JOSH360_GRAPHS_ROOT=$SI/graphs JOSH360_AM_BIN=$C/tests/fakes/agent-manager \
  FAKE_AM_DIR=$SI/am JOSH360_AM_DB=$SI/am/state.db JOSH360_CLAUDE_SETTINGS=$SI/claude-settings.json \
  JOSH360_JIRA_FAKE=$SI/jira WALKER_TEST_PLAN=$SI/plan.json JOSH360_NO_NOTIFY=1 "$@" | python3 -c "import json,sys;d=json.load(sys.stdin);print('exit',d.get('exit_code'));print(d.get('stdout','')[-1500:]);print(d.get('stderr','')[-800:])"
