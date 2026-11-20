"""A read-only look at one ticket in the folder Jira: its status, comments and status changes."""
import json, sys
from pathlib import Path
doc = json.loads((Path(sys.argv[1]) / "fake-jira.json").read_text())
key = sys.argv[2]
print(json.dumps({"status": doc["issues"][key]["fields"]["status"]["name"],
                  "comments": len(doc.get("comments", {}).get(key, [])),
                  "status_changes": [i for c in doc.get("changelogs", {}).get(key, []) for i in c["items"]]}, indent=1))
