"""Stand-ins for the JP-173 sandbox proof: the sample graph with scripted gates (in place of Jira and GitHub), an empty
Agent Manager stand-in folder, and a Claude Code settings file that names hooks/dispatch. Made-up data only."""
import json, re, shutil, subprocess, sys
from pathlib import Path
copy, out = Path(sys.argv[1]), Path(sys.argv[2])
src = (copy / "tests" / "walker_helpers.py").read_text()
scripted = re.search(r'SCRIPTED = """(.*?)"""', src, re.S).group(1).replace("\\\\n", "\\n")
effect = re.search(r'EFFECT = """(.*?)"""', src, re.S).group(1).replace("\\\\n", "\\n")
root = out / "graphs"
shutil.copytree(str(copy / "graphs" / "tests" / "fixtures" / "parts"), str(root))
for gate in ("lint-spec", "check-review", "move-ticket", "ready", "no-loose-ends", "pr-state"):
    (root / "gates" / (gate + ".py")).write_text(scripted)
for name in ("set-flag", "post-comment"):
    (root / "gates" / (name + ".py")).write_text(effect)
(out / "plan.json").write_text("{}")
(out / "am").mkdir()
hooks = {e: [{"hooks": [{"type": "command", "command": "~/.josh-360/repo/hooks/dispatch " + e}]}]
         for e in ("UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop")}
(out / "claude-settings.json").write_text(json.dumps({"hooks": hooks}))
subprocess.run([sys.executable, str(copy / "graphs" / "tools" / "compile_graphs.py"), "--root", str(root)], check=True)
print(json.dumps({"graphs": str(root), "ok": True}))
