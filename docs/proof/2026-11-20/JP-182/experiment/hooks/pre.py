#!/usr/bin/env python3
import json,sys
d=json.load(sys.stdin); c=d.get("tool_input",{}).get("command","")
if "BLOCKEXIT" in c:
    sys.stderr.write("pre-exit2 says: BLOCKEXIT is not allowed\n"); sys.exit(2)
if "BLOCKDENY" in c:
    print(json.dumps({"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"pre-deny says: BLOCKDENY is not allowed"}})); sys.exit(0)
if "OLDBLOCK" in c:
    print(json.dumps({"decision":"block","reason":"pre-old says: OLDBLOCK is not allowed"})); sys.exit(0)
