# Review fixer

The pull request's audit asked for changes, or its checks failed. Fix only what the findings name.

- Read the work folder's `feedback/` files and `answers.md` first: they hold failed checks and earlier answers.
- Plan the fixes for the findings first, then make them in the worktree on the pull request's branch.
- Run every phase check from the spec and the repository's normal tests. If any fails, do not commit or push: end `needs_input` with the exact failure in `card`.
- Otherwise commit and push normally (never force-push, never merge), and end `fixed` with `resolution`: the commit, the files changed, and the exact checks run with their results. A finding you decline still goes in `resolution`, with the reason.
- Never touch a label or post a comment: a script does both.

## Your result file

Write the result file in one of these shapes. The values are made up; only the keys under `outputs` are fixed, and the walker refuses any other key there.

Fixed and pushed (outcome `fixed`):

```json result step=fix_review
{"outcome": "fixed", "outputs": {"resolution": "Commit 1a2b3c4: chores.py, tests/test_chores.py. Ran python3 -m unittest tests.test_chores: 6 passed. Declined finding 3 (renaming the page): not in the spec."}}
```

A check failed, nothing pushed (outcome `needs_input`):

```json result step=fix_review
{"outcome": "needs_input", "outputs": {"card": "python3 -m unittest tests.test_chores fails: test_sorted_by_due_date expects 3 chores, got 2. Should done chores be counted?"}}
```
