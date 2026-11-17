# Feedback file

## Contents

- [What it is](#what-it-is)
- [Fields](#fields)
- [The development graph's feedback](#the-development-graphs-feedback)

## What it is

The defects a reviewer step found, after a gate script has dropped every defect that does not quote the source text (`graphs/CONVENTION.md`, rule 5). For the non-development graph (JP-104) the source text is the ticket's Question and Deliverable format; for the development graph it is the spec (JP-115).

## Fields

A YAML list, one entry per defect.

| Field | What it holds |
| --- | --- |
| `quote` | The exact line of the source text the defect fails. A defect without one is dropped. |
| `where` | The place in the deliverable (a heading, a table row, a figure). |
| `problem` | What is wrong, in one sentence. |
| `fix` | What would make it right, in one sentence. |

## The development graph's feedback

In the development graph (JP-115) the source text is the spec (or, for the hardener, the spec or the ticket). The hardener's kept defects use the fields above. The plan reviewer's defects carry more, because `cite-check` reopens a phase and adds a check from them.

| Field | What it holds |
| --- | --- |
| `phase` | The phase the defect reopens. |
| `criterion` | `DOD-<n>`, `<phase>.task.<n>` or `<phase>.check.<n>` (1-based): the criterion of the spec the defect fails. |
| `quote` | The exact words of that criterion. A defect whose quote is not in the criterion is dropped. |
| `finding` | What is wrong, in one sentence. |
| `required_fix` | What would make it right, in one sentence. |
| `expected_evidence` | What the next run must show to prove it is fixed. |
| `expected_check` | Optional: a shell command that exits 0 once the defect is fixed. It is added to the phase's extra checks once. |

Where the files live, all in the run's `work/` folder: `hardening.md` (the hardener's kept defects, for the designer), `feedback/<phase>.md` (a failing phase's check output from `verify-build`, or a kept review defect, for the builder), and `withdrawn.md` (every defect a script dropped, with the reason). The walker keeps `hardening.md` and every `feedback/*.md` with the run when it ends.
