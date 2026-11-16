"""Recompute the figures JP-96's follow-up writes into docs/inventory/ from the laptop report."""
import json, subprocess
r = json.loads(subprocess.run(["git", "show", "origin/laptop-status:reports/inventory.json"],
                              capture_output=True, text=True, check=True).stdout)
f, de = r["figures"], r["definitions"]
print("run_on", r["run_on"], "seconds", r["seconds"], "schema", r["schema"], "trimmed", r.get("trimmed"))
print("sessions", f["sessions"], "range", f["date_range"], "mean/week", f["mean_sessions_per_week"])
w = [x["sessions"] for x in f["sessions_per_week"]]
print("weekly", w, "last 7 weeks mean", round(sum(w[5:]) / 7, 1), "first 5 weeks", sum(w[:5]))
print("josh messages, all", f["josh_messages_per_session"])
print("josh messages, cli", f["josh_messages_by_entrypoint"]["cli"], "sdk-cli sessions", f["josh_messages_by_entrypoint"]["sdk-cli"]["sessions"])
print("tied to ticket", f["tied_to_ticket"])
le = r["loose_ends"]
print("loose ends", le["local_loose_ends"], le["totals"], "repos", le["repos_found"], "total with cloud", le["local_loose_ends"] + 18 + 19)
sk = de[".claude/skills"]; su = f["skill_use"]
real = [k for k in sk if not k.startswith("twg") and not k.endswith("-workspace")]
print("skill folders", len(real), "called", sum(k in su for k in real), "not called", sum(k not in su for k in real),
      "calls", sum(su[k]["uses"] for k in real if k in su))
ag = de[".claude/agents"]; au = f["agent_use"]
print("agents", len(ag), "not called", sorted(k for k in ag if k not in au))
jobs = r["launchctl"]["jobs"]
for lab in ["com.eventus.athena-pipeline", "com.eventus.azure-batch-spend-alert", "com.eventus.athena-test-suite-sync",
            "com.eventus.qa-waker-watchdog", "com.josh.quicktasks", "com.eventus.meeting-watcher", "com.jgilpatrick.rclone-sync",
            "com.eventus.clickup-notion-sync", "com.eventus.focus-dashboard", "com.omnara.daemon"]:
    print("job", lab, jobs.get(lab, "not loaded"))
hooks = r["claude_settings"][".claude/settings.json"]["hooks"]
print("hook entries", len(hooks), "events", len({h["event"] for h in hooks}),
      "atlas-removal-guard wired", any("atlas-removal-guard" in s for h in hooks for s in h["scripts"]))
st = r["stores"]["known"]
for k in ["~/.claude-mem", "~/.claude/atlas", "~/.claude/cost-ledger", "~/.claude/projects",
          "~/Development/active/obsidian-wiki/raw/claude-sessions", "~/.config/free-claude-code"]:
    v = st[k]; print("store", k, v.get("bytes"), v.get("files"), v.get("newest_change"), "" if v.get("exists", True) else "absent")
print("atlas.db", r["stores"]["children"]["~/.claude/atlas"]["atlas.db"]["bytes"])
