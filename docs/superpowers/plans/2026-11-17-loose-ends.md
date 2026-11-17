# Loose ends and the closeout agent: plan (JP-109)

## Contents

- [Goal](#goal)
- [Choices made while planning](#choices-made-while-planning)
- [Files](#files)
- [Tasks](#tasks)

## Goal

Josh asks "what are my loose ends?" at any moment and gets a list worked out from the ledger, git, GitHub and Jira as they are right then. He can also call a closeout agent that works through that list. Nothing is stored, scheduled or reminded (`docs/design/data-model.md`, "Loose ends are computed, never stored"). Only the laptop's own sessions count (JP-149).

The ticket was `Not Started`, not `Ready`, when this plan was written. Josh ruled on 17 November 2026 that everything in the epic JP-94 not blocked by another ticket is fair game for this project, and JP-107, its only blocker, is Done. The ticket has no open questions, so this plan is the minimum before building.

## Choices made while planning

Each is also a row in `docs/decisions.md`.

1. **The command is `ledger/loose_ends.py`, not a query in `ask.py`.** `ask.py` is the read-only door for working agents. Marking a branch kept is a write that `branch_marks` only accepts from Josh (`marked_by = 'josh'`), so it sits in its own command.
2. **A loose end is one item per thing, not per session.** Five sessions on one unpushed branch give one item that names all five sessions. "For one session" filters the same items.
3. **Unknown is not clean.** When git, GitHub or Jira cannot be read, the check goes in an `unchecked` list with the reason. It never turns into "no loose end".
4. **Branches are found through the repository, not through the worktree.** A session's `git_root` may be a worktree that is gone. The command resolves it to the main checkout (`git rev-parse --git-common-dir`; failing that, the part of the path before `/.claude/worktrees/`). Kept-on-purpose marks are stored against that main checkout.
5. **The closeout script acts on reversible items only and re-checks each one just before it acts.** It never uses a force flag, never deletes a remote branch, and removes a worktree only when `git status --ignored` is empty and its commits are on a remote branch or the default branch. Everything else is a proposal for Josh.
6. **Jira work on tickets is the agent's step, not the script's.** The script lists and proposes; the closeout agent moves a ticket to Done only when the merged work is evidence.

## Files

| File | What it is |
| --- | --- |
| `ledger/loose_ends.py` | Collects items; `list`, `session`, `keep`, `unkeep`. Python 3.9, standard library only. |
| `ledger/closeout.py` | Proposes an action per item; `--apply` carries out the reversible ones. |
| `ledger/live.py` | Reads a ticket's status from Jira and a pull request's state from GitHub, as unknown when it cannot. Used by both commands and by `ask.py changes --live`. |
| `ledger/ask.py` | `changes --live` adds the ticket's status and the pull request's state to each row. |
| `.claude/agents/closeout.md`, `.claude/commands/closeout.md` | The closeout agent Josh calls. |
| `tests/test_loose_ends.py`, `tests/test_closeout.py`, `tests/test_live.py`, `tests/loose_helpers.py` | Tests against made-up repositories built in a temp folder. |

## Tasks

- [ ] **1. Live readers** (`ledger/live.py`, `tests/test_live.py`): ticket status category and pull request state, injected fetchers, `None` when unknown.
- [ ] **2. Collector** (`ledger/loose_ends.py`, `tests/test_loose_ends.py`): the six kinds, ages, kept marks, `unchecked`, one-session filter, text and JSON output. One test per scenario in the ticket, plus one per kind.
- [ ] **3. Closeout script** (`ledger/closeout.py`, `tests/test_closeout.py`): proposals, `--apply` for reversible items, the never-destroys-work test.
- [ ] **4. `ask.py changes --live`**: replace the "not built yet" note and its test.
- [ ] **5. Agent and command** (`.claude/agents/closeout.md`, `.claude/commands/closeout.md`).
- [ ] **6. Docs and proof**: `ledger/README.md`, `AGENTS.md` commands, `docs/decisions.md`, `docs/proof/2026-11-17/JP-109/README.md` mapping each scenario to its test, and a run on a made-up repository.
- [ ] **7. Check, PR, ceremony, merge, Jira.**
