# Architecture (JP-144)

## Contents

- [What this is](#what-this-is)
- [Files](#files)
- [Changing the page](#changing-the-page)

## What this is

One page that shows josh-360 as a single application, drawn on 17 November 2026 before the ledger build (JP-107) started, at Josh's request:

- **The parts:** five layers (where Josh works, workflow, data, laptop base, what stays separate), each part tagged with its phase and the feature-tree ids it is built from.
- **How data moves:** one ticket's trip from Jira through the runner, walker, Agent Manager, Needs you and the PR audit, and where each fact lands in `ledger.db` and `cache.db`.
- **Salvage map:** every feature of action-triage, Session Atlas, macbook-automations and agent-deck from the feature tree, plus claude-harness and the rest of the laptop, sorted into kept as is, onto the ledger, rebuilt or new, later, and dropped.
- **Phase 1 and later:** the tickets in each phase, what keeps running meanwhile, and each gate.
- **Points this raises:** three things the picture shows, each with a recommendation for the ticket that settles it.

The published page is https://claude.ai/artifact/Ae3bfNBPprWqg4iZYUPbgM.

## Files

| File | What it is |
| --- | --- |
| `page.template.html` | The page: drawings, text and script, with a placeholder where the data goes. |
| `laptop-pieces.yaml` | Salvage rows for claude-harness and the laptop, which the feature tree does not cover. Every row repeats a verdict already made (JP-96, JP-100, JP-106). |
| `architecture.html` | The built page. Do not edit it by hand. |
| `../../../scripts/architecture_page.py` | `check` validates the extra rows and that the built page is up to date; `build` rebuilds the page. |

The salvage map reads `docs/design/feature-tree/tree.yaml` directly, so a change to a call there shows up here on the next build.

## Changing the page

1. Edit `page.template.html` or `laptop-pieces.yaml`, or change the feature tree.
2. Run `python3 scripts/architecture_page.py build`.
3. Run `python3 scripts/check.py`. It fails while the built page is out of date.
4. Republish the page to the same link.
