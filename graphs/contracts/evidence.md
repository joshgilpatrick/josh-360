# Evidence file

## Contents

- [What it is](#what-it-is)
- [Where it lives](#where-it-lives)
- [Fields](#fields)
- [Patient data](#patient-data)

## What it is

The record of what a run produced and what it rests on. The step that does the work writes it; the gate scripts after it read it. Designed in JP-104 for the non-development graph; the development graph adds its own fields when it is written (JP-115).

## Where it lives

Beside the deliverable, in Josh's artifacts folder for the ticket's system (`~/Development/active/.artifacts/<system>/`), named `<KEY>-evidence.md`. Saved queries sit beside it as `<KEY>-query-<n>.sql`. Nothing lives inside a repository or a worktree, so cleanup cannot remove it.

## Fields

A YAML block at the top, then free notes.

| Field | What it holds |
| --- | --- |
| `ticket` | The ticket key. |
| `kind` | The work kind the run used. |
| `phi` | `true` when the deliverable may hold patient data. |
| `deliverables` | The path of each deliverable file. |
| `summary` | Two or three sentences a person can act on without opening the deliverable. Left empty when `phi` is true. |
| `sources` | One row per source: `type` (`query`, `file`, `ticket`, `doc`, `meeting`, `web`), `ref` (a path, key or link), and `used_for` (which claim it supports). At least one. |
| `assumptions` | Each reading the work chose where the ticket could be read two ways. |
| `precedent` | The earlier ticket the work started from, or `none`. |
| `recipient` | Who the deliverable is meant for when it is not only Josh (a person's name and address, or a ticket key outside JP), else `none`. |
| `resolution` | The text of the closing comment: the question restated and the answer in one or two sentences. Left empty when `phi` is true. |

## Patient data

When `phi` is true, `summary` and `resolution` stay empty and the ticket, the email to Josh and the ledger carry the paths only. The deliverable, the evidence file and the saved queries may hold patient data because they live outside every repository, in the folder Josh's rules set aside for files meant for his own review.
