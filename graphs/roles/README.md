# Roles

One folder per role: `role.yaml` (`title`, `may_change`, `tier`, optional `reviewer`) and `instructions.md`. See `graphs/CONVENTION.md`, "Roles".

**Work outside the ticket (every role, JP-175).** A step session that finds work its ticket does not cover does not do it. It reports it in its result file as `follow_ups` (`contracts/follow-up.md`): a one-line summary, why it is outside the ticket, and whether it blocks the ticket. A script files each one through intake and tells the sprint or epic lead. The binding's prompt says this to every role session, so no role's own instructions repeat it.

**Example results (every role, JP-189).** Each role's `instructions.md` ends with "Your result file": at least one example result per step that uses the role, tagged ```` ```json result step=<step> ````, with only the step's declared outputs under `outputs`. `python3 graphs/tools/role_examples.py check` (part of `scripts/check.py`) keeps them true to the compiled graphs, and the stand-in Claude Code in the cloud tests writes the step's first example.

| Role | Used by | What it does |
| --- | --- | --- |
| `intake-reader` | ticket-creation | Turns one loose input into an intake record (`contracts/intake-record.md`). |
| `jira-searcher` | ticket-creation, non-development | Looks for existing Jira tickets that match a request. |
| `decomposer` | ticket-creation | Decides whether a request is one ticket or a parent with children, and proposes the shape. |
| `ticket-drafter` | ticket-creation, triage | Writes the full text of each ticket in a proposal (`contracts/ticket-proposal.md`). |
| `sign-off` | triage | Decides whether one drafted ticket is Ready, on the six items scripts cannot check. |
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
