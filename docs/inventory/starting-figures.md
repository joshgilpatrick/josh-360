# Starting figures

## Contents

- [What this file is](#what-this-file-is)
- [The figures](#the-figures)
- [How each figure is counted](#how-each-figure-is-counted)
- [How to reproduce them](#how-to-reproduce-them)
- [Limits](#limits)

## What this file is

The numbers later change is measured against (JP-96). Each figure states its date range and the command or query that produced it. Counts only: no message text, file contents or patient data.

Two figures need the laptop, because the session history lives only there. They come from the one read-only laptop script, `scripts/laptop_inventory.py`, which the laptop runs once on its own as the JP-105 job `inventory`; its report comes back on the `laptop-status` branch as `reports/inventory.json`. Until then those rows say "waiting for the laptop run". The cloud figures are filled in now.

## The figures

| Figure | Value | Date range | Produced by |
| --- | --- | --- | --- |
| Sessions per week (mean) | waiting for the laptop run | the 12 whole weeks (Monday to Sunday) before the run | `laptop_inventory.py`, field `figures.mean_sessions_per_week`; the week-by-week counts are in `figures.sessions_per_week` |
| Josh's messages per session (median, mean, 90th percentile) | waiting for the laptop run | the same 12 weeks | `figures.josh_messages_per_session`; split by how the session was started in `figures.josh_messages_by_entrypoint` |
| Share of sessions tied to a ticket | waiting for the laptop run | the same 12 weeks | `figures.tied_to_ticket.share_by_branch_or_message` (keys JP, AD, CI, GIL); the branch-only count is `figures.tied_to_ticket.by_branch` |
| Open loose ends on the laptop (git) | waiting for the laptop run | the moment of the run | `loose_ends.local_loose_ends`, the sum of branches with no remote, branches ahead of their remote, branches whose remote is gone, and extra worktrees, over every repository under `~/Development` and `~/.claude` |
| Open pull requests authored by Josh | 18, in 13 repositories, opened between 2026-06-19 and 2026-11-16 | open on 2026-11-16 | `gh api -X GET search/issues -f q='is:pr is:open author:joshgilpatrick'` (repositories this GitHub access can see) |
| Tickets in flight (JP and AD, not Done) | 19 | in flight on 2026-11-16 | Jira: `project in (JP, AD) AND status in ("In Progress", "Code Review", "Validation", "Design/Planning") AND (assignee = currentUser() OR assignee is EMPTY)` |

The total of open loose ends is the laptop's git count plus the two cloud counts above. It is written here once the laptop run returns.

## How each figure is counted

- **Session.** One top-level Claude Code transcript, `~/.claude/projects/<project>/<id>.jsonl`. Subagent transcripts (`<id>/subagents/*.jsonl`) are not sessions. A session belongs to the week of its first timestamp, in the laptop's time zone.
- **Josh's message.** A `user` entry a person typed. Not counted: meta entries, sidechains, tool results, compaction summaries, and text Claude Code injects (slash-command echoes, command output, system reminders, task notices, "Request interrupted"). Headless sessions started by a daemon count their opening prompt as one message, so the figure is also given per entry point (`cli` is an interactive terminal).
- **Tied to a ticket.** A ticket key (`JP-n`, `AD-n`, `CI-n`, `GIL-n`) in the session's git branch, or in one of Josh's own messages. A key that only Claude mentions does not count.
- **Loose end.** Josh's definition: commits with no branch or pull request, a local branch with no remote, a linked ticket not Done, an open pull request, a leftover worktree, an orphaned branch. The laptop script counts the git half without changing anything (`git for-each-ref`, `git worktree list`, `git rev-list --walk-reflogs --count refs/stash`); stashes are reported but not added to the total. Open pull requests and tickets not Done are counted in the cloud. Linking tickets to sessions waits for the ledger (JP-107), so the ticket count is every in-flight JP and AD ticket.
- **Skill and agent use** (for the inventory's "no recent use" list). Skill tool calls and slash commands, and Agent or Task calls by agent type, over the 90 days before the run, with each one's last use (`figures.skill_use`, `figures.agent_use`).

## How to reproduce them

The laptop's job runner does it once, with no one at the keyboard (`scripts/laptop_inventory_job.py`, job `inventory` in `jobs.yaml`). To run it again by hand, on the laptop, from a josh-360 checkout:

```bash
python3 scripts/laptop_inventory.py --out ~/josh-360-inventory.json
```

Options: `--out -` prints the report instead of writing a file, `--skip-prompting-folders` leaves out the folders macOS may guard with a privacy prompt, `--since` and `--until` (dates) change the range, `--ticket-keys` the keys, `--repo-root` the folders searched for repositories, and `--usage-days` the window for skill and agent use. The script refuses to overwrite an existing file and writes nothing else. Its tests run on made-up data: `python3 -m unittest discover -s tests -v`.

## Limits

- Transcripts older than Claude Code's own clean-up period are gone, so a long range can undercount.
- The ticket share misses sessions that worked a ticket without naming it in the branch or in Josh's words.
- The pull request count covers only the repositories this cloud session's GitHub access can see.
