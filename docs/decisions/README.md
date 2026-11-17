# Decisions made while building

## Contents

- [Why one file per ticket](#why-one-file-per-ticket)
- [Writing a row](#writing-a-row)
- [Reading them](#reading-them)
- [When a merge brings in the old table](#when-a-merge-brings-in-the-old-table)

## Why one file per ticket

Every build thread records the undoable choices it makes. They used to go in one table in `docs/decisions.md`, so any two open pull requests edited the same lines and conflicted (JP-153). Now a ticket writes only `docs/decisions/JP-<n>.md`, a file no other ticket touches. `docs/decisions.md` keeps Josh's own recorded decisions.

## Writing a row

Create `docs/decisions/JP-<n>.md` the first time the ticket makes a choice, with this header, and add one row per choice (the date is the day of the choice):

```markdown
# JP-<n> decisions

| Date | Ticket | Question | Option taken | How to undo |
| --- | --- | --- | --- | --- |
| 2026-11-17 | JP-<n> | The question that came up. | What you chose, and why. | The steps that reverse it, or "Not needed". |
```

A pipe inside a cell is written `\|`. No patient data. A ticket that records no choices writes no file.

## Reading them

- `python3 scripts/decisions.py list` prints every row; `--ticket JP-<n>` prints one ticket's.
- `python3 scripts/decisions.py check` runs inside `python3 scripts/check.py`. It fails when a file is not named for its ticket, a row has the wrong shape or names another ticket, or a default-choice row is left in `docs/decisions.md`.

## When a merge brings in the old table

A branch cut before JP-153 added rows to the table in `docs/decisions.md`, and merging `main` into it conflicts there. Take `main`'s version of `docs/decisions.md`, then paste your rows into `docs/decisions/JP-<n>.md` as above. `scripts/decisions.py check` names any row you missed.
