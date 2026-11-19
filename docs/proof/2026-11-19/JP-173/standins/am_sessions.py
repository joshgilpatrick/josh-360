"""A read-only look at the stand-in Agent Manager's sessions table: id, name, group, archived."""
import json, sqlite3, sys
conn = sqlite3.connect("file:{}?mode=ro".format(sys.argv[1]), uri=True)
print(json.dumps([dict(zip(("id", "name", "group", "archived"), r)) for r in
                  conn.execute("SELECT id, name, group_name, archived FROM sessions ORDER BY id")], indent=1))
