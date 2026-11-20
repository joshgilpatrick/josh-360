---
name: review-hook-blocks
description: "Use when Josh asks whether any Claude Code hook is too strict, why a hook keeps blocking, or for a review of hook blocks on his laptop. Runs scripts/hook_blocks.py over the stored transcripts and writes a review note with one verdict per blocking hook (keep, narrow or bug). Changes no hook."
---

# Review hook blocks

`scripts/hook_blocks.py` (JP-182) lists every time any hook on Josh's laptop stopped Claude: josh-360's own hooks, the claude-harness settings hooks, plugin hooks and project hooks such as action-triage's guardrails. This skill turns that list into a verdict per hook. It runs on the laptop only, from Josh's own Claude session.

## Steps

1. Run `python3 ~/.josh-360/repo/scripts/hook_blocks.py` (default window 14 days; `--days N` to change it; `/usr/bin/python3` if `python3` is older than 3.9). It prints the path of the review file, `~/.josh-360/reviews/hook-blocks/hook-blocks-<date>.md`, with the same data in the `.json` beside it, and the count per hook.
2. Read the review file: the summary table first, then the blocks of each hook with one or more blocks. A hook with 0 blocks needs no verdict. Note the skipped transcripts: a block inside one of them is not counted.
3. For each blocking hook, open its source (the Script column; for a josh-360 hook, also the files it names, such as `apps/session-atlas/hooks/atlas-removal-guard.js` or `graphs/runner/runner_lib/hooklib.py`). Find the rule that produced each message.
4. For each hook, look at every block (or at least ten, chosen across its messages) and decide whether the rule was right that time: did the attempted call really do what the rule exists to stop? "Likely false alarm" and the next action are pointers, not answers: a read-only `cat .env` blocked by a secret guard is a right block even though it changes nothing.
5. Give each blocking hook one verdict:
   - **keep**: the blocks were right, or the few wrong ones cost little.
   - **narrow**: the rule is right in purpose but catches things it should not. Say which pattern to stop catching, with the examples.
   - **bug**: the hook blocks for a reason its own rule does not intend (a parse error, a wrong path, failing closed on its own error).
   For "unknown (<Event>)" rows, first say which candidate it most likely was from the message, then give the verdict.
6. Write the note to `~/.josh-360/reviews/hook-blocks/review-<date>.md` (never inside a repository), with a `## Contents` list and one section per hook: verdict, block count and false-alarm count, the rule in the source (file and line), two to five examples quoted from the review file, and the change that would fix it in one or two sentences.
7. Tell Josh in a few lines: each hook's verdict and count, and the path of the note. Offer to file a ticket for each **narrow** or **bug** verdict.

## Rules

- Change no hook and no settings file. A fix is its own ticket after Josh reads the note.
- The review file and the note can hold patient data (blocked commands, prompts, messages). They stay on the laptop. A ticket, PR, comment or the laptop-status branch may carry only hook names, counts, verdicts and a description of the pattern in general words, never a quoted command, prompt, path from a patient folder or message.
- A cloud session cannot run this: the transcripts are only on the laptop.
