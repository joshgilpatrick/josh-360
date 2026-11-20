#!/usr/bin/env python3
import json,sys,os
d=json.load(sys.stdin)
m="/tmp/jp182-submark-"+d.get("session_id","x")
if d.get("stop_hook_active") or os.path.exists(m): sys.exit(0)
open(m,"w").close()
print(json.dumps({"decision":"block","reason":"substop-block says: subagent must echo SUBAFTER"}))
