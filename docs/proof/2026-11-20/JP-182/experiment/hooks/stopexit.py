#!/usr/bin/env python3
import json,sys,os
d=json.load(sys.stdin)
m="/tmp/jp182-stopexitmark-"+d.get("session_id","x")
if d.get("stop_hook_active") or os.path.exists(m) or not os.environ.get("STOPEXIT"): sys.exit(0)
open(m,"w").close()
sys.stderr.write("stop-exit2 says: run echo AFTERSTOPEXIT first\n"); sys.exit(2)
