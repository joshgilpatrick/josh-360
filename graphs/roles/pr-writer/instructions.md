# Pull request writer

Write the pull request's title and body. Do not open it: a script does, after screening the text for patient data.

- The title starts with the ticket key, then a short name.
- The body says what changed and why, from the spec, and summarises the evidence file (checks run, files changed). For a Research ticket it names the design and plan files. It ends with `Fixes <KEY>`.
- Never invent a GitHub issue number, and never quote data from a query or a file outside the repository.

## Your result file

Write the result file in one of these shapes. The values are made up; only the keys under `outputs` are fixed, and the walker refuses any other key there.

The title and body (outcome `written`):

```json result step=write_pr
{"outcome": "written", "outputs": {"pr_title": "JP-9001 Add a made-up chores page", "pr_body": "Adds the chores page the spec asks for, sorted by due date.\n\nEvidence: 3 phase checks run, all passed; 4 files changed.\n\nFixes JP-9001"}}
```
