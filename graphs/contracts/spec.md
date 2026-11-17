# Spec

## Contents

- [What it is](#what-it-is)
- [Where it lives](#where-it-lives)
- [Fields](#fields)
- [How the scripts read it](#how-the-scripts-read-it)
- [A Research ticket's spec](#a-research-tickets-spec)

## What it is

The plan a builder follows without inferring anything. The development graph's designer writes it, the hardener attacks it, `lint-spec`, `verify-build` and `cite-check` read it, and the plan reviewer may cite nothing else. Designed in JP-115 (`docs/superpowers/specs/2026-11-17-development-graph-design.md`), from the spec in Josh's drafted pipeline (`docs/source-notes/jira-ticket-pipeline-roles-and-scripts.md`, "roles/designer").

## Where it lives

`<run folder>/work/spec.yaml` (`$JOSH360_RUNS/<run id>/work/`, default `~/.josh-360/runs/`). Never inside a repository or a worktree, so removing the worktree cannot remove it. `lint-spec` refuses a spec path inside a worktree. The walker copies it into the run's `saved/` folder, with its hash, when the run ends.

The same folder holds the run's other working files: `state.json` (each phase's status and extra checks), `evidence.md` (contract `evidence`), `hardening.md` and `feedback/<phase>.md` (contract `feedback`), `withdrawn.md` (defects a script dropped, with the reason), `answers.md` (answers to earlier questions) and `pr-cursor.json` (the audit round).

## Fields

YAML.

| Field | What it holds |
| --- | --- |
| `ticket` | The ticket key. |
| `summary` | One paragraph: what the build changes and why, in plain words. The pull request body starts from it. |
| `definition_of_done` | A list of `{id: DOD-<n>, rule}`. Always the five standard items below, plus any the ticket adds. |
| `phases` | The build, in order. Each phase is `{id, title, task, checks, files}`: `id` a short word (`p1`), `task` a list with one action per item, `checks` a list of shell commands run from the worktree that exit 0 when the phase is done, `files` the files the phase may change. |
| `scenarios` | One row per Gherkin scenario of the ticket: `{name, tag, proved_by}`, where `proved_by` names a phase check (`p2.check.1`) for `@auto`, or a proof path for `@e2e` and `@manual`. |

There is no tier field. Every phase is built by the builder role at its own tier (Josh, 16 November 2026: tiers are chosen by step, not by difficulty).

The five standard items, from Josh's draft:

```yaml
definition_of_done:
  - { id: DOD-1, rule: "No placeholders: no TODO, FIXME, stub bodies, NotImplemented, fake data or commented-out code in files this plan changed, unless a phase names it as intended." }
  - { id: DOD-2, rule: "Every item in a phase's task list is implemented in full." }
  - { id: DOD-3, rule: "Tests assert the behaviour the phase names. None is skipped, tautological or mocks out the code under test, and at least one test per phase fails when the feature is removed." }
  - { id: DOD-4, rule: "Every check of every phase ran and passed on the final tree (see evidence.md)." }
  - { id: DOD-5, rule: "Files changed are the files the phases name." }
```

## How the scripts read it

- `lint-spec` checks the shape: at least one `DOD-<n>` item with a rule; every phase with an id, a non-empty task list, at least one check and a files list; every scenario of the ticket in `scenarios`.
- `verify-build` runs every phase's `checks`, plus the extra checks a kept review defect added (in `state.json`), on the worktree's final tree.
- `cite-check` resolves a defect's `criterion` to `DOD-<n>`, `<phase>.task.<n>` or `<phase>.check.<n>` (1-based), and keeps it only when its `quote` is in that criterion's text.

## A Research ticket's spec

A Research ticket's deliverable is a design and a plan, so its spec is the design document itself, written where the repository keeps designs (in josh-360, `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`, following `docs/WORKFLOW.md` section 2), with the plan beside it. Both are committed on the ticket's branch and merged through the pull request, which is what keeps them. `lint-spec` checks that the design has a `## Contents` section, a Gherkin block and an "Out of scope" section, and that the plan exists.
