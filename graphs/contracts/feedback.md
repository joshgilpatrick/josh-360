# Feedback file

## Contents

- [What it is](#what-it-is)
- [Fields](#fields)

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
