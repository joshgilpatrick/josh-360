---
description: Review every Claude Code hook block on this laptop and give each blocking hook a verdict (keep, narrow or bug); changes no hook
---
Use the `review-hook-blocks` skill. Run `python3 ~/.josh-360/repo/scripts/hook_blocks.py $ARGUMENTS` on this laptop, read the review file it names, read each blocking hook's source, and write the review note under `~/.josh-360/reviews/hook-blocks/`. Tell Josh each hook's verdict and count and where the note is. Change no hook, and put no quoted command or message in any ticket or PR.
