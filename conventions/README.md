# Conventions

Ticket conventions, the system registry and the standing priorities (JP-98).

| File | What it holds |
| --- | --- |
| `tickets.md` | The ticket rules for all of Josh's work: when work needs a ticket, where it lives, types, sections, the Ready rule, labels, branches and statuses. |
| `registry.yaml` | Every system: its folders and repositories, area, Jira space, default parent epic and priority. |
| `priorities.yaml` | Josh's seven standing priorities (the six from the leadership forum and Internal Systems & Applications), plus DevEx and Unassigned, and what each covers in Jira. Josh edits it by hand. |

Check both data files after an edit with `python3 scripts/conventions.py check`. Find where a folder or repository belongs with `python3 scripts/conventions.py lookup --folder <path>` or `--repo <name>`.
