# Roles

One folder per role: `role.yaml` (`title`, `may_change`, `tier`, optional `reviewer`) and `instructions.md`. See `graphs/CONVENTION.md`, "Roles".

| Role | Used by | What it does |
| --- | --- | --- |
| `intake-reader` | ticket-creation | Turns one loose input into an intake record (`contracts/intake-record.md`). |
| `jira-searcher` | ticket-creation, non-development | Looks for existing Jira tickets that match a request. |
| `decomposer` | ticket-creation | Decides whether a request is one ticket or a parent with children, and proposes the shape. |
| `ticket-drafter` | ticket-creation, triage | Writes the full text of each ticket in a proposal (`contracts/ticket-proposal.md`). |
| `sign-off` | triage | Decides whether one drafted ticket is Ready, on the five items scripts cannot check. |
| `precedent-judge` | non-development | Decides whether an earlier ticket's resolution already answers this one. |
| `researcher` | non-development | Produces a non-development ticket's deliverable and its evidence. |
| `work-checker` | non-development | Checks a finished deliverable against its ticket and lists defects only. |
| `designer` | development | Turns a Ready development ticket into a spec a builder can follow. |
| `hardener` | development | Attacks the spec once and flags what would make a builder fail or guess. |
| `builder` | development | Builds every phase of a finished spec in the worktree. |
| `build-triager` | development | Decides who answers a judgment call a builder stopped on. |
| `plan-reviewer` | development | Checks that the build did the work the spec assigned. |
| `pr-writer` | development | Writes the pull request's title and body; a script opens it. |
| `review-fixer` | development | Fixes only what a pull request's audit or failed checks name. |
