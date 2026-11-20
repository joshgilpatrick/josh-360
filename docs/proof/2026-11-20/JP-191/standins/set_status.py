"""Stand-in for a Done gate: set the run file's `jira_status`, which is what the walker leaves after a gate moved the
ticket (the runner reads nothing else)."""
import json, sys
from pathlib import Path
path = Path(sys.argv[1]) / sys.argv[2] / "run.json"
doc = json.loads(path.read_text())
doc["jira_status"] = sys.argv[3]
path.write_text(json.dumps(doc, indent=1))
print(json.dumps({"run": sys.argv[2], "jira_status": sys.argv[3]}))
