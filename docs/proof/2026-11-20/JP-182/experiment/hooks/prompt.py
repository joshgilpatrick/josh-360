#!/usr/bin/env python3
import json,sys
d=json.load(sys.stdin); p=d.get("prompt","")
if "PROMPTBLOCK" in p:
    print(json.dumps({"decision":"block","reason":"prompt-block says: no PROMPTBLOCK"}))
if "PROMPTEXIT" in p:
    sys.stderr.write("prompt-exit2 says: no PROMPTEXIT\n"); sys.exit(2)
