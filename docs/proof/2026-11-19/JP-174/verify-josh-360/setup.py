"""Made-up state for the JP-174 sandbox run: a registered clone with two graph worktrees, three graph runs in the
ledger, and one linked build step session for JP-900. Run with the sandbox's HOME, from its ~/.josh-360/repo."""
import datetime, json, os, subprocess, sys, time
from pathlib import Path
sys.path.insert(0, os.getcwd())
from ledger import db

home = Path(os.environ["HOME"])
j360 = Path(os.environ["JOSH360_HOME"])
clone = home / "Development" / "active" / "josh_360"
clone.mkdir(parents=True, exist_ok=True)
subprocess.run(["git", "init", "-q", str(clone)], check=True)
for name in ("JP-902-x", "JP-906-y", "JP-900-login"):
    (clone / ".claude" / "worktrees" / name).mkdir(parents=True, exist_ok=True)

now = datetime.datetime.now(datetime.timezone.utc)
stamp = lambda days: (now - datetime.timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")
conn = db.connect(j360 / "state" / "ledger.db")
machine = db.machine_id(conn)
for run, ticket, ended in (("r-00000000a902", "JP-902", 8), ("r-00000000a906", "JP-906", 6), ("r-00000000a900", "JP-900", None)):
    conn.execute("INSERT INTO graph_runs (run_id, machine_id, graph_id, graph_source, graph_version, subject_kind, "
                 "subject_ref, tracker, ticket_key, phi, runner, started_at, recorded_by) VALUES (?, ?, 'development', "
                 "'graph-file', 'abc123', 'ticket', ?, 'jira', ?, 0, 'agent-manager', ?, 'jp174-setup')",
                 (run, machine, ticket, ticket, stamp(10)))
    if ended:
        conn.execute("INSERT INTO run_ends (run_id, end_name, score, version, ended_at, recorded_by) "
                     "VALUES (?, 'stop', 'neutral', 1, ?, 'jp174-setup')", (run, stamp(ended)))
conn.commit()
conn.close()

run = "r-00000000a900"
folder = j360 / "runs" / run
for sub in ("results", "outputs", "saved", "work"):
    (folder / sub).mkdir(parents=True, exist_ok=True)
tree = str(clone / ".claude" / "worktrees" / "JP-900-login")
(folder / "run.json").write_text(json.dumps({"inputs": {"ticket_key": "JP-900"}, "outputs": {"prepare": {
    "worktree": tree, "branch": "JP-900-login", "work_dir": str(folder / "work")}}}))
entry = {"run": run, "step": "build", "attempt": 1, "graph": "development", "ticket": "JP-900", "access": "josh",
         "tier": "mid", "outcomes": ["built"], "result_file": str(folder / "results" / "build-1.json"),
         "work_dir": str(folder / "work"), "run_folder": str(folder), "started_at": time.time(), "am_session": None,
         "nudged_at": None}
(j360 / "state" / "graph-sessions").mkdir(parents=True, exist_ok=True)
(j360 / "state" / "graph-sessions" / "cc-jp174.json").write_text(json.dumps(entry))
print(json.dumps({"clone": str(clone), "worktree": tree, "runs": 3, "session": "cc-jp174"}))
