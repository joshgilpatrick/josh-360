#!/bin/bash
# JP-182: the throwaway sessions that showed how Claude Code stores each kind of hook block (run 2026-11-20 in a
# cloud container, Claude Code 2.1.329). Run from an empty folder with this folder's hooks/ and settings.json copied
# in as hooks/ and .claude/settings.json; the transcripts land in ~/.claude/projects/<folder>/. Costs a few cents.
set -eu
m=claude-haiku-5-5
claude -p "Run each of these as its own separate Bash tool call, one at a time, in order, even if one fails: 1) echo BLOCKEXIT one  2) echo BLOCKDENY two  3) echo OLDBLOCK two-b  4) echo POSTBLOCK three  5) echo POSTEXIT three-b  6) echo fine four. Then reply DONE." --model $m --permission-mode bypassPermissions </dev/null
claude -p "say hi PROMPTBLOCK" --model $m </dev/null || true
claude -p "say hi PROMPTEXIT" --model $m </dev/null || true
STOPEXIT=1 claude -p "reply ok" --model $m --permission-mode bypassPermissions </dev/null
claude -p "First run the Bash command: echo SECONDHOOK alpha. Then reply DONE." --model $m --permission-mode bypassPermissions </dev/null
claude -p "Use the Agent tool to launch one general-purpose subagent with this exact instruction: 'Run the Bash command echo BLOCKEXIT sub, then run the Bash command echo fine sub, then report back.' Then reply DONE." --model $m --permission-mode bypassPermissions </dev/null
