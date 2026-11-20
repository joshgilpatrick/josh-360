#!/usr/bin/env python3
import json,sys
d=json.load(sys.stdin); c=d.get("tool_input",{}).get("command","")
if "SECONDHOOK" in c:
    sys.stderr.write("pre2-exit2 says: SECONDHOOK is not allowed\n"); sys.exit(2)
