---
description: Work through Josh's loose ends with the closeout agent (reversible items done, deletions asked first)
---
Use the `closeout` subagent. Give it any session id or ticket key from `$ARGUMENTS` (with none, it covers every session on this laptop). It reads the live list from `ledger/closeout.py`, carries out the reversible items, checks tickets against merged work, and brings the rest to Josh one decision at a time. Report its summary, not its working.
