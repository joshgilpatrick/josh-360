# Hook block review

Made 2026-11-20T14:24:12Z for the 14 days since 2026-11-06. Read 9 transcripts (0 skipped, 0 partly read). 13 blocks by 7 hooks; 5 look like false alarms. 18 hooks are listed in all.

This file can hold patient data: it quotes blocked commands, prompts and messages. It stays on this laptop. Never paste it into GitHub, Jira or the laptop-status branch; hook names and counts are the only parts that may go anywhere else.

## Contents

- [Summary by hook](#summary-by-hook)
- [Blocks](#blocks)
- [Skipped transcripts](#skipped-transcripts)
- [Settings that could not be read](#settings-that-could-not-be-read)
- [How to read this file](#how-to-read-this-file)

## Summary by hook

| Hook | Source | Event | Matcher | Blocks | Likely false alarms | Script |
| --- | --- | --- | --- | --- | --- | --- |
| project proj:pre.py | project | PreToolUse | `Bash` | 4 | 4 | `/tmp/claude-0/hx/proj/hooks/pre.py` |
| project proj:post.py | project | PostToolUse | `Bash` | 2 | 0 | `/tmp/claude-0/hx/proj/hooks/post.py` |
| project proj:stop.py | project | Stop | all | 2 | 0 | `/tmp/claude-0/hx/proj/hooks/stop.py` |
| project proj:prompt.py | project | UserPromptSubmit | all | 2 | 0 | `/tmp/claude-0/hx/proj/hooks/prompt.py` |
| project proj:pre2.py | project | PreToolUse | `Bash\|Read` | 1 | 1 | `/tmp/claude-0/hx/proj/hooks/pre2.py` |
| project proj:stopexit.py | project | Stop | all | 1 | 0 | `/tmp/claude-0/hx/proj/hooks/stopexit.py` |
| project proj:substop.py | project | SubagentStop | all | 1 | 0 | `/tmp/claude-0/hx/proj/hooks/substop.py` |
| josh-360:PostToolUse/20-graph-step-reflect (no dispatcher entry for PostToolUse, so it never runs) | josh-360 | PostToolUse | all | 0 | 0 | `/home/claude/josh-360/hooks/PostToolUse/20-graph-step-reflect` |
| josh-360:PostToolUse/40-jira-session-link (no dispatcher entry for PostToolUse, so it never runs) | josh-360 | PostToolUse | all | 0 | 0 | `/home/claude/josh-360/hooks/PostToolUse/40-jira-session-link` |
| josh-360:PostToolUse/40-ticket-comments (no dispatcher entry for PostToolUse, so it never runs) | josh-360 | PostToolUse | all | 0 | 0 | `/home/claude/josh-360/hooks/PostToolUse/40-ticket-comments` |
| josh-360:PreToolUse/10-atlas-removal-guard (no dispatcher entry for PreToolUse, so it never runs) | josh-360 | PreToolUse | all | 0 | 0 | `/home/claude/josh-360/hooks/PreToolUse/10-atlas-removal-guard` |
| josh-360:PreToolUse/20-graph-step-guard (no dispatcher entry for PreToolUse, so it never runs) | josh-360 | PreToolUse | all | 0 | 0 | `/home/claude/josh-360/hooks/PreToolUse/20-graph-step-guard` |
| josh-360:PreToolUse/30-ticket-offer (no dispatcher entry for PreToolUse, so it never runs) | josh-360 | PreToolUse | all | 0 | 0 | `/home/claude/josh-360/hooks/PreToolUse/30-ticket-offer` |
| josh-360:SessionEnd/20-ledger-spool (no dispatcher entry for SessionEnd, so it never runs) | josh-360 | SessionEnd | all | 0 | 0 | `/home/claude/josh-360/hooks/SessionEnd/20-ledger-spool` |
| josh-360:SessionStart/20-ledger-spool (no dispatcher entry for SessionStart, so it never runs) | josh-360 | SessionStart | all | 0 | 0 | `/home/claude/josh-360/hooks/SessionStart/20-ledger-spool` |
| josh-360:Stop/20-graph-step-stop (no dispatcher entry for Stop, so it never runs) | josh-360 | Stop | all | 0 | 0 | `/home/claude/josh-360/hooks/Stop/20-graph-step-stop` |
| josh-360:UserPromptSubmit/20-graph-step (no dispatcher entry for UserPromptSubmit, so it never runs) | josh-360 | UserPromptSubmit | all | 0 | 0 | `/home/claude/josh-360/hooks/UserPromptSubmit/20-graph-step` |
| josh-360:UserPromptSubmit/40-ticket-comments (no dispatcher entry for UserPromptSubmit, so it never runs) | josh-360 | UserPromptSubmit | all | 0 | 0 | `/home/claude/josh-360/hooks/UserPromptSubmit/40-ticket-comments` |

## Blocks

### project proj:pre.py

4 blocks, 4 likely false alarms. Source: `/tmp/claude-0/hx/proj/hooks/pre.py`.

- **2026-11-20T14:10:51.963Z**, session `b22c3c1f-de14-44cd-a90a-69a173f7bd82`, folder `/tmp/claude-0/hx/proj`
  - Event and tool: PreToolUse / Bash
  - Hook: project proj:pre.py (found by message text; label `command hook`)
  - Attempted: `echo BLOCKEXIT one`
  - Message: `pre-exit2 says: BLOCKEXIT is not allowed`
  - Next: moved-on (next: Bash)
  - Likely false alarm: yes, the blocked call changes nothing
  - Transcript: `/root/.claude/projects/-tmp-claude-0-hx-proj/b22c3c1f-de14-44cd-a90a-69a173f7bd82.jsonl`
- **2026-11-20T14:10:53.699Z**, session `b22c3c1f-de14-44cd-a90a-69a173f7bd82`, folder `/tmp/claude-0/hx/proj`
  - Event and tool: PreToolUse / Bash
  - Hook: project proj:pre.py (found by message text)
  - Attempted: `echo BLOCKDENY two`
  - Message: `pre-deny says: BLOCKDENY is not allowed`
  - Next: moved-on (next: Bash)
  - Likely false alarm: yes, the blocked call changes nothing
  - Transcript: `/root/.claude/projects/-tmp-claude-0-hx-proj/b22c3c1f-de14-44cd-a90a-69a173f7bd82.jsonl`
- **2026-11-20T14:10:55.251Z**, session `b22c3c1f-de14-44cd-a90a-69a173f7bd82`, folder `/tmp/claude-0/hx/proj`
  - Event and tool: PreToolUse / Bash
  - Hook: project proj:pre.py (found by message text)
  - Attempted: `echo OLDBLOCK two-b`
  - Message: `pre-old says: OLDBLOCK is not allowed`
  - Next: moved-on (next: Bash)
  - Likely false alarm: yes, the blocked call changes nothing
  - Transcript: `/root/.claude/projects/-tmp-claude-0-hx-proj/b22c3c1f-de14-44cd-a90a-69a173f7bd82.jsonl`
- **2026-11-20T14:13:01.168Z**, session `2e4ec575-e563-4637-8874-1eb9c25482ad` subagent `a990382845c2f0208`, folder `/tmp/claude-0/hx/proj`
  - Event and tool: PreToolUse / Bash
  - Hook: project proj:pre.py (found by message text; label `command hook 1`)
  - Attempted: `echo BLOCKEXIT sub`
  - Message: `pre-exit2 says: BLOCKEXIT is not allowed`
  - Next: moved-on (next: Bash)
  - Likely false alarm: yes, the blocked call changes nothing
  - Transcript: `/root/.claude/projects/-tmp-claude-0-hx-proj/2e4ec575-e563-4637-8874-1eb9c25482ad/subagents/agent-a990382845c2f0208.jsonl`

### project proj:post.py

2 blocks, 0 likely false alarms. Source: `/tmp/claude-0/hx/proj/hooks/post.py`.

- **2026-11-20T14:10:56.700Z**, session `b22c3c1f-de14-44cd-a90a-69a173f7bd82`, folder `/tmp/claude-0/hx/proj`
  - Event and tool: PostToolUse / Bash
  - Hook: project proj:post.py (found by message text; label `command hook`)
  - Attempted: `echo POSTBLOCK three`
  - Message: `post-block says: POSTBLOCK output is bad`
  - Next: moved-on (next: Bash)
  - Likely false alarm: no
  - Transcript: `/root/.claude/projects/-tmp-claude-0-hx-proj/b22c3c1f-de14-44cd-a90a-69a173f7bd82.jsonl`
- **2026-11-20T14:10:58.170Z**, session `b22c3c1f-de14-44cd-a90a-69a173f7bd82`, folder `/tmp/claude-0/hx/proj`
  - Event and tool: PostToolUse / Bash
  - Hook: project proj:post.py (found by message text; label `command hook`)
  - Attempted: `echo POSTEXIT three-b`
  - Message: `post-exit2 says: POSTEXIT is bad`
  - Next: moved-on (next: Bash)
  - Likely false alarm: no
  - Transcript: `/root/.claude/projects/-tmp-claude-0-hx-proj/b22c3c1f-de14-44cd-a90a-69a173f7bd82.jsonl`

### project proj:stop.py

2 blocks, 0 likely false alarms. Source: `/tmp/claude-0/hx/proj/hooks/stop.py`.

- **2026-11-20T14:11:04.292Z**, session `b22c3c1f-de14-44cd-a90a-69a173f7bd82`, folder `/tmp/claude-0/hx/proj`
  - Event and tool: Stop
  - Hook: project proj:stop.py (found by message text; label `command hook 1`)
  - Attempted: `end the turn: DONE All six commands ran as separate calls, in order. Four were blocked or flagged by hooks: 1. 'echo BLOCKEXIT one': blocked by a PreToolUse hook ('pre-exit2…`
  - Message: `stop-block says: run echo AFTERSTOP first`
  - Next: continued (kept working after the block)
  - Likely false alarm: no
  - Transcript: `/root/.claude/projects/-tmp-claude-0-hx-proj/b22c3c1f-de14-44cd-a90a-69a173f7bd82.jsonl`
- **2026-11-20T14:11:28.200Z**, session `70eea6a9-696d-4bd8-81c4-82e733383eeb`, folder `/tmp/claude-0/hx/proj`
  - Event and tool: Stop
  - Hook: project proj:stop.py (found by message text; label `command hook 1`)
  - Attempted: `end the turn: ok`
  - Message: `stop-block says: run echo AFTERSTOP first`
  - Next: continued (kept working after the block)
  - Likely false alarm: no
  - Transcript: `/root/.claude/projects/-tmp-claude-0-hx-proj/70eea6a9-696d-4bd8-81c4-82e733383eeb.jsonl`

### project proj:prompt.py

2 blocks, 0 likely false alarms. Source: `/tmp/claude-0/hx/proj/hooks/prompt.py`.

- **2026-11-20T14:11:15.323Z**, session `632d6cbf-1f55-4f7e-a425-82f94848dc5d`, folder `/tmp/claude-0/hx/proj`
  - Event and tool: UserPromptSubmit
  - Hook: project proj:prompt.py (found by message text)
  - Attempted: `say hi PROMPTBLOCK`
  - Message: `prompt-block says: no PROMPTBLOCK`
  - Next: unknown (no later prompt)
  - Likely false alarm: no
  - Transcript: `/root/.claude/projects/-tmp-claude-0-hx-proj/632d6cbf-1f55-4f7e-a425-82f94848dc5d.jsonl`
- **2026-11-20T14:11:20.027Z**, session `b20b2e60-4682-4ef5-b033-26636feaaefb`, folder `/tmp/claude-0/hx/proj`
  - Event and tool: UserPromptSubmit
  - Hook: project proj:prompt.py (found by message text; label `command hook`)
  - Attempted: `say hi PROMPTEXIT`
  - Message: `prompt-exit2 says: no PROMPTEXIT`
  - Next: unknown (no later prompt)
  - Likely false alarm: no
  - Transcript: `/root/.claude/projects/-tmp-claude-0-hx-proj/b20b2e60-4682-4ef5-b033-26636feaaefb.jsonl`

### project proj:pre2.py

1 blocks, 1 likely false alarms. Source: `/tmp/claude-0/hx/proj/hooks/pre2.py`.

- **2026-11-20T14:12:42.125Z**, session `c0f377d8-27e8-4153-8cbc-b8987c49329b`, folder `/tmp/claude-0/hx/proj`
  - Event and tool: PreToolUse / Bash
  - Hook: project proj:pre2.py (found by message text; label `command hook 2`)
  - Attempted: `echo SECONDHOOK alpha`
  - Message: `pre2-exit2 says: SECONDHOOK is not allowed`
  - Next: gave-up (ended the turn without trying again)
  - Likely false alarm: yes, the blocked call changes nothing
  - Transcript: `/root/.claude/projects/-tmp-claude-0-hx-proj/c0f377d8-27e8-4153-8cbc-b8987c49329b.jsonl`

### project proj:stopexit.py

1 blocks, 0 likely false alarms. Source: `/tmp/claude-0/hx/proj/hooks/stopexit.py`.

- **2026-11-20T14:11:28.200Z**, session `70eea6a9-696d-4bd8-81c4-82e733383eeb`, folder `/tmp/claude-0/hx/proj`
  - Event and tool: Stop
  - Hook: project proj:stopexit.py (found by message text; label `command hook 2`)
  - Attempted: `end the turn: ok`
  - Message: `stop-exit2 says: run echo AFTERSTOPEXIT first`
  - Next: continued (kept working after the block)
  - Likely false alarm: no
  - Transcript: `/root/.claude/projects/-tmp-claude-0-hx-proj/70eea6a9-696d-4bd8-81c4-82e733383eeb.jsonl`

### project proj:substop.py

1 blocks, 0 likely false alarms. Source: `/tmp/claude-0/hx/proj/hooks/substop.py`.

- **2026-11-20T14:13:04.976Z**, session `2e4ec575-e563-4637-8874-1eb9c25482ad` subagent `a990382845c2f0208`, folder `/tmp/claude-0/hx/proj`
  - Event and tool: SubagentStop
  - Hook: project proj:substop.py (found by message text; label `command hook`)
  - Attempted: `end the turn: Both commands have been run, but only one succeeded. - 'echo BLOCKEXIT sub' was blocked by a PreToolUse hook before it ran. The hook returned: "pre-exit2 says:…`
  - Message: `substop-block says: subagent must echo SUBAFTER`
  - Next: continued (kept working after the block)
  - Likely false alarm: no
  - Transcript: `/root/.claude/projects/-tmp-claude-0-hx-proj/2e4ec575-e563-4637-8874-1eb9c25482ad/subagents/agent-a990382845c2f0208.jsonl`

## Skipped transcripts

None: every transcript in the window was read.

## Settings that could not be read

None.

## How to read this file

- A hook is named by its source: `user` (~/.claude/settings.json), `project <folder>`, `plugin <name>`, `extra <file>` (a settings file passed with --settings), `managed`, or `josh-360:<Event>/<file>` (a file the josh-360 dispatcher runs).
- Found by: `hooks.log` (the dispatcher's log names the file), `message text` (the message's wording is in that hook's source), `only candidate` (the one hook that runs there), `command in message`, or `unknown` (several hooks could have done it; the candidates are listed).
- Next: retried, other-way-succeeded, other-way-failed, asked-josh, gave-up, moved-on, continued (Stop), unknown (nothing follows in the transcript).
- Likely false alarm: the same job was done straight after another way, or the blocked call reads only. It is a pointer for the reviewer, not a verdict.
