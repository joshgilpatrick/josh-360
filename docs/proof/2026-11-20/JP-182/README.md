# JP-182 proof: every hook block, listed for review

## Contents

- [What was built](#what-was-built)
- [How Claude Code stores a block](#how-claude-code-stores-a-block)
- [Scenarios](#scenarios)
- [A run over the real test sessions](#a-run-over-the-real-test-sessions)
- [What still needs the laptop](#what-still-needs-the-laptop)

## What was built

- `scripts/hook_blocks.py` (with `scripts/hook_blocks_lib/`) reads the stored transcripts for a window (default 14 days) and writes `~/.josh-360/reviews/hook-blocks/hook-blocks-<date>.md`, with the same data as `.json`. Per block: time, session (and subagent), folder, event, tool, hook and how it was found, what was attempted, the message, what the agent did next, and whether it looks like a false alarm. A summary at the top lists every hook on the laptop, blocking or not: user and managed settings, settings passed with `--settings` (action-triage's guardrails), project settings of every folder a transcript ran in, enabled plugins, and the josh-360 files behind the dispatcher. Unreadable transcripts are listed as skipped.
- `.claude/skills/review-hook-blocks/` (and `/review-hooks`) runs it, reads each blocking hook's source and writes a note with one verdict per hook: keep, narrow or bug. It changes no hook.
- The doctor's `hooks.log` check now counts blocks as well as failures, and names the hook rather than the word "failed".

Choices: `docs/decisions/JP-182.md`.

## How Claude Code stores a block

The ticket's first step. `experiment/` holds made-up hooks, one for each kind of block, and `run.sh`, the six throwaway sessions run on 2026-11-20 in a cloud container (Claude Code 2.1.329, Haiku). `transcript-shapes.jsonl` is every entry those sessions wrote about a block, trimmed to the fields that matter.

| Kind | Where it is in the transcript |
| --- | --- |
| PreToolUse exit 2 | the tool's `tool_result`, `is_error: true`, content `PreToolUse:Bash hook error: [command hook]: <stderr>` (`[command hook 2]` when it was the second of the hooks that ran) |
| PreToolUse JSON `deny`, and the old `decision: block` | the same, with the reason and no label: `PreToolUse:Bash hook error: <reason>` |
| PostToolUse `block` or exit 2 | an attachment `{"type": "hook_blocking_error", "hookEvent": "PostToolUse", "hookName": "PostToolUse:Bash", "toolUseID", "blockingError": {"blockingError": <message>, "command": "command hook"}}` after the tool's normal result |
| Stop `block` or exit 2 | a `system` entry, `subtype: stop_hook_summary`, with one `hookErrors` item per blocking hook; an attachment as above is written for some of them only, so the summary is what is counted |
| SubagentStop | the attachment, in the subagent's own transcript (`<session>/subagents/agent-<id>.jsonl`), with no summary |
| UserPromptSubmit `block` or exit 2 | a `system` entry with `promptSubmitEnding.ending = {"kind": "blocked_by_hook", "reason": <message>}`; its content ends `Original prompt: <prompt>` |

No transcript names the hook's file: only "command hook" or "command hook N". So the command finds it from the dispatcher's `hooks.log`, from the message's wording in the hook's source, or from being the only hook that runs there (decisions file, first row).

## Scenarios

Each `@auto` scenario is a test in `tests/test_hook_blocks.py`, on made-up transcripts in the shapes above (`tests/hook_blocks_helpers.py`).

| Scenario | Test |
| --- | --- |
| Every kind of block in a transcript is listed (`@auto`) | `EveryKind.test_every_kind_of_block_is_listed_with_every_field`: an exit-2 PreToolUse, a JSON deny, a Stop block and a UserPromptSubmit block, each with time, session, folder, event, tool, hook, attempted input, message and next action; also `test_a_stop_block_is_counted_once`, and `Attribution.test_subagent_blocks_and_old_blocks` for SubagentStop and the window |
| A reworded retry that succeeds is flagged as a likely false alarm (`@auto`) | `Reworded.test_a_reworded_retry_that_succeeds_is_a_likely_false_alarm` (and the retried and failed cases beside it) |
| Hooks that never blocked still appear (`@auto`) | `NeverBlocked.test_hooks_that_never_blocked_still_appear`; `test_every_source_is_listed` covers project, plugin, `--settings` and josh-360 hooks |
| An unreadable transcript is not read as "no blocks" (`@auto`) | `Unreadable.test_an_unreadable_transcript_is_skipped_and_named` |
| The review stays on the laptop (`@auto`) | `StaysOnTheLaptop`: every new file is under `~/.josh-360/` (mode 0600), an `--out-dir` elsewhere is refused, and the code imports no network, subprocess or git module |
| Doctor counts blocks (`@auto`) | `DoctorCountsBlocks.test_a_block_in_the_last_day_is_named_with_its_count` |
| First real review on the laptop (`@manual`) | owed on the laptop, below |

## A run over the real test sessions

`sample-run.txt` and `sample-review.md` are the command's output over the six sessions above (no settings file but the test project's): all 13 blocks found, every one matched to the hook that made it by its message text, 5 marked as likely false alarms (the four `echo` commands a PreToolUse hook stopped change nothing). The josh-360 rows say "no dispatcher entry" because the cloud container has none; on the laptop they are registered.

## What still needs the laptop

The `@manual` scenario, once the merge has installed (about 10 minutes):

1. In a Claude Code session in `~/.josh-360/repo`, run `/review-hooks` (or ask "are any of my hooks too strict?", which loads the `review-hook-blocks` skill).
2. It should run `python3 ~/.josh-360/repo/scripts/hook_blocks.py`, print the review file's path and a count per hook, then write `~/.josh-360/reviews/hook-blocks/review-<date>.md` with a verdict per blocking hook.
3. Check: the josh-360 Atlas removal guard (`josh-360:PreToolUse/10-atlas-removal-guard`) appears with its JP-157 false blocks if they are still inside 14 days (add `--days 30` if not), and hooks from outside josh-360 (claude-harness settings, plugins, action-triage's guardrails) appear in the summary.
4. Check the "Skipped transcripts" section: a long list there means a transcript shape this version does not read, and is worth a ticket.

Nothing the command or the skill writes leaves the laptop. The only parts that may go in Jira are hook names, counts and verdicts.
