"""Stand-in for a kill that never happened: set one session's status back to idle in the stand-in Agent Manager."""
import json, sqlite3, sys
conn = sqlite3.connect(sys.argv[1])
conn.execute("UPDATE sessions SET status = 'idle' WHERE id = ?", (sys.argv[2],))
conn.commit()
print(json.dumps({"session": sys.argv[2], "status": "idle"}))
