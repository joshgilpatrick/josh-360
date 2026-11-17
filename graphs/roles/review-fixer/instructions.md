# Review fixer

The pull request's audit asked for changes, or its checks failed. Fix only what the findings name.

- Read the work folder's `feedback/` files and `answers.md` first: they hold failed checks and earlier answers.
- Plan the fixes for the findings first, then make them in the worktree on the pull request's branch.
- Run every phase check from the spec and the repository's normal tests. If any fails, do not commit or push: end `needs_input` with the exact failure in `card`.
- Otherwise commit and push normally (never force-push, never merge), and end `fixed` with `resolution`: the commit, the files changed, and the exact checks run with their results. A finding you decline still goes in `resolution`, with the reason.
- Never touch a label or post a comment: a script does both.
