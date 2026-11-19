# Validation section

## Contents

- [What it is](#what-it-is)
- [The fields](#the-fields)
- [Examples](#examples)
- [The two scenario forms](#the-two-scenario-forms)
- [Comparisons and values](#comparisons-and-values)
- [Collectors](#collectors)
- [What the parser reports](#what-the-parser-reports)
- [Adding a collector](#adding-a-collector)

## What it is

The section a Story, Task or Bug carries after its Acceptance criteria (`conventions/tickets.md`, "Required sections"). It says whether the change needs a watch once it runs in production, and if so how often to look and what a good reading is. A Research ticket, an Epic and a Subtask have none.

One parser reads it for everything that needs it: `graphs/gates/lib/validation_section.py` (`parse`, `parse_text`, `route`, `needs_watch`). The Ready check (V1 to V7), the validation graph's first step and the movers' rule all use it, so a section that passed Ready is one the graph can read. The list of collectors it checks against is `graphs/gates/lib/collectors/__init__.py` (`DECLARED`). Design: `docs/superpowers/specs/2026-11-18-post-deploy-validation-design.md`.

The argument on a `When` line is data for a collector's own reader. It is kept as text and never run as a command.

## The fields

Each field is one line, `<Field>: <value>`, optionally as a list item. The name is matched without regard to case. A field written twice is a problem.

| Field | What it answers | Allowed values |
| --- | --- | --- |
| Needed | Does this ticket need a watch after it ships? | `yes`, or `no.` followed by a reason of at least four words. With `no`, the section is that one line and nothing else |
| Starts | When does the watch begin? | `at Deployed`, `on 2026-12-01` (a real calendar date), or `after JP-170 is Done` (another ticket, never this one) |
| Check every | How often is a reading taken? | `<n> hours` or `<n> days`, from 1 hour to 7 days |
| Complete when | When is it enough? | `<n> checks in a row pass`, or `after <n> events`; n is at least 1 |
| Give up after | How long does it watch before stopping without an answer? | `<n> days`, from 1 to 90 |
| Fail after (optional) | How many failing checks in a row end the watch early? | `<n> checks in a row fail`; 3 when the line is left out |
| Criteria | What shows the change does its job in production? | One or more scenarios tagged `@validate`, in a `gherkin` block |

## Examples

**Watch for seven good days** (a Bug whose fix is "the hourly Session Atlas retirement job stops failing"):

````markdown
**Validation:**

- Needed: yes
- Starts: at Deployed
- Check every: 1 day
- Complete when: 7 checks in a row pass
- Give up after: 21 days

```gherkin
@validate
Scenario: The retirement job runs clean
  When the watch reads job retire-session-atlas
  Then last_exit is 0
  And hours_since_run is at most 2

@validate
Scenario: The doctor reports no failed check
  When the watch reads report doctor summary.fail
  Then value is 0
```
````

Once the ticket is in Deployed, look once a day; when the job's last run exited clean, ran in the last two hours, and the doctor shows no failed check, seven days running, the ticket is proven. If that has not happened in 21 days, stop.

**Wait for a number of real events** (a change proven by things happening rather than days passing):

````markdown
**Validation:**

- Needed: yes
- Starts: at Deployed
- Check every: 1 day
- Complete when: after 20 events
- Give up after: 30 days

```gherkin
@validate
Scenario: Forwarded emails end with a signed-off deliverable
  When the watch reads ledger-runs non-development
  Then needs_josh is at most 1
```
````

Wait until 20 non-development runs have ended since the watch started, then look once: at most one of them may have ended needing Josh. `after <n> events` is used only with collectors that count events (the last column of the collector table).

**A ticket that needs no watch:**

```markdown
**Validation:**

- Needed: no. The change is a document; nothing runs in production.
```

**When is the answer yes?** When the change's effect can only be seen once it runs for real: a background job, a hook, a pipeline, a graph, anything whose proof is "it kept working" or "the numbers moved". The answer is no for a document, a design, a change fully proven by its tests, or a one-time script whose result is already in the pull request's proof.

## The two scenario forms

Every scenario in the block is tagged `@validate`; an untagged one is refused (V4), because a criterion nobody watches is worse than a refused ticket. Each is one criterion, numbered V1, V2, ... in order.

- **A measured scenario** has exactly one `When` line, `When the watch reads <collector> <argument>` (the first word after "reads" names the collector; the rest of the line is its argument), and one or more `Then` or `And` lines, `<field> <comparison> <value>`. It has no `Given` line.
- **A manual scenario** is tagged `@validate @manual` and is the one line `Then Josh confirms that <statement>`. It has no `When`. Scripts watch the measured criteria; when those are met, Josh gets one question listing the manual ones. Use a manual scenario only where no collector could measure the thing: the sign-off agent sends a ticket back (J6) if a manual criterion could have been a measured one. A section needs at least one measured scenario.

## Comparisons and values

The comparison is one of these, matched longest first:

| Comparison | Reads | Needs |
| --- | --- | --- |
| `is` | equal | a number or a word |
| `is not` | different | a number or a word |
| `is at least` | greater than or equal | two numbers |
| `is at most` | less than or equal | two numbers |
| `is above` | greater than | two numbers |
| `is below` | less than | two numbers |

The value is a number, or one word of letters, digits, `_`, `.` and `-` (up to 32 characters). A number field is compared with a number; an ordering comparison is never used with a word or with a field that holds a code. The field must be one the collector returns.

## Collectors

A collector is a small read-only function that returns one reading: named numbers and short codes, plus a link a person can follow. When it cannot read, the answer is unknown, which is never a pass or a fail. A collector never returns text copied from the system it read, so a reading cannot carry patient data.

| Collector | Argument | Fields it returns | Counts events | Reads |
| --- | --- | --- | --- | --- |
| `job` | a job id from `jobs.yaml`, such as `retire-session-atlas` | `last_exit` (0 is a clean run), `hours_since_run` | no | the job runner's state file |
| `report` | a report id and a dotted path, such as `doctor summary.fail` | `value`, `age_hours` | no | the report that job last wrote |
| `doctor` | a doctor check id, such as `backfills.retire-session-atlas` | `status` (`pass`, `warn`, `fail` or `skip`) | no | the doctor's last report |
| `ledger-runs` | a graph id, such as `non-development` | `events` (runs ended since the watch started), `success`, `neutral`, `needs_josh` | yes | the ledger, read-only |
| `jira-count` | a JQL search, on one line | `count`, `events` (the same number) | yes | Jira's search, with the runner's own credentials |
| `github-runs` | `owner/repo` and a workflow file name, then optionally a branch | `events` (runs since the watch started), `failed`, `last` (`success` or `failure`) | yes | GitHub, read-only |

Each argument must match its collector's pattern in `DECLARED`, as a whole. A field of kind `number` holds a number, `code` a short code, and `value` either.

## What the parser reports

A problem is an object of the same four keys as a Ready-checklist failure (`ready-checklist.md`): `item`, `where` (always `Validation`), `found` and `needed`. The items V1 to V7 are listed in `conventions/tickets.md`, "The Ready rule". `parse` returns the section with `present`, `needed`, `reason`, the timetable (`starts`, `starts_kind`, `check_every_hours`, `complete_when`, `complete_kind`, `complete_n`, `give_up_days`, `fail_after`), the `criteria` list, a `section_version` (the first 16 hex digits of a hash of the section's text) and the `problems`.

`route` answers `not_needed` (no section, or `Needed: no`), `watch` (`Needed: yes` and nothing wrong) or `unreadable` (anything else).

## Adding a collector

A collector is one module in `graphs/gates/lib/collectors/` with a `read(argument, since)` function, an entry in `DECLARED` (its argument pattern, its fields and whether it counts events), one row in the collector table above and its tests. The Ready check and the watch load the same list, so a ticket can name a new collector the day it merges.
