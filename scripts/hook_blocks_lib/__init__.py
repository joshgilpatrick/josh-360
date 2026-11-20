"""JP-182: list every time a Claude Code hook blocked something, from the stored transcripts, so an agent can say which
hooks are too strict. Runs on the laptop (Python 3.9, standard library only) and reads only; the one thing it writes
is the review file under ~/.josh-360/. Entry point: scripts/hook_blocks.py.

- inventory.py   every hook on the laptop: settings files, project settings, enabled plugins, josh-360 hooks/
- transcripts.py the blocks inside one transcript, in the shapes Claude Code stores them
- follow.py      what the agent did next, and whether the block looks like a false alarm
- attribute.py   which hook blocked
- report.py      the review file (Markdown and JSON)
"""
