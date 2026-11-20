#!/usr/bin/env python3
import json,sys
d=json.load(sys.stdin); c=d.get("tool_input",{}).get("command","")
if "POSTBLOCK" in c:
    print(json.dumps({"decision":"block","reason":"post-block says: POSTBLOCK output is bad"}))
if "POSTEXIT" in c:
    sys.stderr.write("post-exit2 says: POSTEXIT is bad\n"); sys.exit(2)
