"""The stand-in for a step session: writes the step's result where the runner told it to, and comes to rest."""
import json, sqlite3, sys
from pathlib import Path
runs, run, step, outcome, outputs, am_db = sys.argv[1:7]
doc = json.loads((Path(runs) / run / "sessions" / "{}-1.json".format(step)).read_text())
Path(doc["result_file"]).parent.mkdir(parents=True, exist_ok=True)
Path(doc["result_file"]).write_text(json.dumps({"outcome": outcome, "outputs": json.loads(outputs)}))
conn = sqlite3.connect(am_db)
conn.execute("UPDATE sessions SET status = 'idle' WHERE id = ?", (doc["handle"]["am_session"],))
conn.commit()
print(json.dumps({"session": doc["handle"]["am_session"], "name": doc.get("session_name"), "wrote": outcome}))
