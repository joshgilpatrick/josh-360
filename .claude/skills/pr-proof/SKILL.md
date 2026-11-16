---
name: pr-proof
description: "Use before opening any josh-360 PR: run the real thing, capture proof of every scenario (screenshots for a screen, command or test output otherwise), show it in the thread, commit it, and post it on the PR so it renders."
---

# Proof before the PR

Rules: `docs/WORKFLOW.md` §3.3. Surfaces and how to run the app: `.claude/workflow.config.md`.

1. Start the app (or run the script) the way the config says, against made-up sample data and local services only. Never touch a target listed under "Never a test or deploy target".
2. With a screen: drive it with Playwright through each `@e2e` scenario. Screenshots a person will see: device scale 2. Without a screen: run each scenario's command and keep its output.
3. Save proof as `docs/proof/YYYY-MM-DD/JP-n/<surface-or-step>-<nn>-<what>.png` (or `.txt` for output). Show it in the thread **before** the PR opens.
4. Commit and push it (a push to a PR branch starts no CI).
5. After the PR exists, post screenshots as a PR comment: markdown image syntax `![what](https://raw.githubusercontent.com/joshgilpatrick/josh-360/<sha>/docs/proof/…png)`, never `<img>` tags. One image per comment, or tile several into contact sheets first (`montage *.png -tile 4x -geometry 540x960+12+12 -background '#F4F0EC' contact-1.png`). Text proof goes in the PR's proof table as a path.
6. Read each comment back. If an image URL came back wrapped in backticks, update the comment with the identical body.
7. A scenario you could not run says so, with the reason, in the thread and the PR's proof table.
