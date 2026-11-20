"""Stand-in for the clock: move a session's `filed_at` in the runner's tickets file back by some days, as if that much
time had passed since it was filed in completed-steps. Only that field changes. Usage: age.py <file> <session>=<days>..."""
import json, sys
from pathlib import Path
path = Path(sys.argv[1])
back = {k: float(v) for k, v in (a.split("=") for a in sys.argv[2:])}
doc = json.loads(path.read_text())
moved = {}
for rec in doc["tickets"].values():
    for s in rec["sessions"]:
        if s.get("am_session") in back and s.get("filed_at") is not None:
            s["filed_at"] -= back[s["am_session"]] * 86400
            moved[s["am_session"]] = back[s["am_session"]]
path.write_text(json.dumps(doc, indent=1, sort_keys=True))
print(json.dumps({"moved_back_days": moved}))
