# Feature tree (JP-143)

## Contents

- [What this is](#what-this-is)
- [Files](#files)
- [Changing the tree](#changing-the-tree)
- [Reading Josh's answers](#reading-joshs-answers)

## What this is

Every feature of action-triage, claude-360 (Session Atlas) and macbook-automations, plus the agent-deck hooks on the laptop, as one tree. Each feature carries a keep or drop call, how it comes in (or why it does not), the part of the one josh-360 app it lands in, and its reason. Josh asked for it on 17 November 2026: the three repositories are melded into one app with one theme, with features extracted and rebuilt, not nested.

Node ids are stable. A and S ids are the rows of `docs/inventory/features.md` (JP-97); M ids are macbook-automations; D ids are agent-deck. JP-111 and JP-124 cite these ids.

## Files

| File | What it is |
| --- | --- |
| `tree.yaml` | The tree: the source of truth. Its header comment documents every field. |
| `page.template.html` | The review page, with a placeholder where the tree goes. |
| `review-page.html` | The built page. Do not edit it by hand. |
| `../../../scripts/feature_tree.py` | `check` validates the tree and that the built page is up to date; `build` rebuilds the page. |

The published page is https://claude.ai/artifact/PSsUz1u6kD6zZLaymNfxH3.

## Changing the tree

1. Edit `tree.yaml` (or the template).
2. Run `python3 scripts/feature_tree.py build`.
3. Run `python3 scripts/check.py`; it fails if the page is out of date or a node is missing a call, a reason or a home.
4. Republish the page to the same artifact so Josh's saved answers stay with it.

## Reading Josh's answers

The page saves to its own store, document `reviews/featureTree`: `{nodes: {<id>: {keep?: bool, comment?: string}}, submittedAt}`. `keep` is stored only where Josh changed the call. A thread reads it with the ArtifactData tool (`get`, collection `reviews`, doc id `featureTree`) on the artifact above, then writes the calls into `docs/inventory/features.md`, `docs/decisions.md`, JP-111 and JP-124.
