---
description: Check that every part of Josh 360 is present and configured on this laptop (read-only)
---
Use the `platform-doctor` skill. Run `python3 ~/.josh-360/repo/scripts/doctor.py --json $ARGUMENTS` on this laptop, read the JSON, and report in plain words: how many checks pass, then each `fail` and `warn` with its `fix` step, and the `manual` checks that only Josh can do. Run nothing that changes the laptop unless Josh asks for `--fix`.
