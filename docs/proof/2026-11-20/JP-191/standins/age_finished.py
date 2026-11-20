"""Stand-in for the clock, for the doctor: move every `finished_at` in the runner's tickets file back by some days, as
if the doctor ran that much later. Only that field changes. Usage: age_finished.py <file> <days>"""
import json, sys
from pathlib import Path
path, days = Path(sys.argv[1]), float(sys.argv[2])
doc = json.loads(path.read_text())
moved = []
for rec in doc["tickets"].values():
    for s in rec["sessions"]:
        if s.get("finished_at") is not None:
            s["finished_at"] -= days * 86400
            moved.append(s["am_session"])
path.write_text(json.dumps(doc, indent=1, sort_keys=True))
print(json.dumps({"moved_back": moved, "days": days}))
