# JP-197 proof: the removal guard no longer blocks a `[:N]` slice

## Contents

- [What broke](#what-broke)
- [What changed](#what-changed)
- [What was run](#what-was-run)
- [Before and after](#before-and-after)
- [On the laptop](#on-the-laptop)

## What broke

On 20 November, while Josh's laptop diagnosed JP-116's run, the Atlas removal guard blocked a read-only command: a piped `python3 -c` one-liner that prints the first three rows of `git worktree list` output. The guard read the slice `[:3]]` as a shell glob, treated a glob as "any path that starts with the folder before it", and so saw a command that might delete the main checkout. It blocked with "split the command into simple commands".

## What changed

`apps/session-atlas/hooks/atlas-removal-guard.js` now reads a word whose only expansions are `*`, `?` and `[...]` as the glob it is. It takes the literal folder before the first pattern level, then matches each later level as one name. A glob blocks only when it can stand for a worktree or main checkout, a folder holding one, or the `.git` entry inside one (as `W/*` does). So `[:3]]` in the current folder no longer stands for the checkout, while `rm -rf [.]claude`, `rm -rf ../proj*` and `rm -rf <work>/*` still block.

Anything the guard still cannot read keeps the old, wider rule and blocks as before: a variable, a command substitution, a brace list, `**`, a `.` or `..` after a pattern level, or a bracket with no closing `]`. The choices are in [`docs/decisions/JP-197.md`](../../../decisions/JP-197.md).

## What was run

In a cloud session on 20 November 2026, with Node 22, on made-up repositories in a temporary folder:

- `node --test test/hooks/removal-guard-false-positives.test.ts` with this branch's guard: 7 of 7 pass ([`new-tests.txt`](new-tests.txt)).
- The same file with `main`'s guard put back: test 5 fails, the other 6 pass ([`old-tests.txt`](old-tests.txt)). Tests 6 and 7 are the globs that must still block, and they pass on both.
- `npm test --prefix apps/session-atlas`: 1,093 tests, 1,076 pass, 17 skipped, 0 fail.
- `npm run typecheck --prefix apps/session-atlas`: clean.
- `python3 scripts/check.py`: 0 problems.

## Before and after

| Command (cwd: a main checkout with two worktrees) | `main`'s guard | This branch |
| --- | --- | --- |
| `cat f \| python3 -c 'import sys,json; [print(r["worktree"][:40]) for r in json.load(sys.stdin)[:3]]'` | blocked (exit 2) | allowed (exit 0) |
| `rm -rf [.]claude` with worktrees under `.claude/worktrees` | blocked | blocked |
| `rm -rf ../proj*` | blocked | blocked |
| `rm -rf <home>/plain/*.tmp` | allowed | allowed: no checkout can match |

The old guard's message for the first command:

```text
Atlas removal guard blocked this command [manual-resolution]: "[:3]]" (word "[:3]]") appears to target the main checkout "<home>/work/proj" in a form the guard cannot check
```

## On the laptop

Nothing to do by hand. The hook is installed from `main`, so the laptop picks up the new guard after the merge. `/review-hooks` (JP-182) will show whether any slice or bracket still gets blocked.
