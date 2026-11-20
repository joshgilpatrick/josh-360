"""Stand-in Jira: add a made-up ticket to the folder Jira at a status. Usage: add_ticket.py <folder> <KEY> <status>"""
import json, sys
from pathlib import Path
path = Path(sys.argv[1]) / "fake-jira.json"
doc = json.loads(path.read_text())
doc.setdefault("issues", {})[sys.argv[2]] = {"key": sys.argv[2], "fields": {"status": {"name": sys.argv[3]},
                                                                           "issuetype": {"name": "Bug"}, "labels": []}}
path.write_text(json.dumps(doc))
print(json.dumps({"added": sys.argv[2], "status": sys.argv[3]}))
