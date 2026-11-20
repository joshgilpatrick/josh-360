"""A made-up JOSH360_HOME for the console tests and proof (JP-185). Nothing here is real: tickets are JP-900 and up,
run ids are r-0000aa..., sessions sess-0001..., folders sample names.

    python3 tests/console_fixture.py <folder>   build one, to run `scripts/console.py --once` against
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from ledger import db  # noqa: E402

RUN = "r-0000aa11bb22"
RUN2 = "r-0000cc33dd44"


def stamp(minute: int, second: int = 0) -> str:
    return "2026-11-20T14:{:02d}:{:02d}Z".format(minute, second)


def build(home: Path) -> Path:
    """The home; every source has a few lines between 14:00 and 14:20 UTC on 2026-11-20."""
    state, logs = home / "state", home / "logs"
    (logs / "runner").mkdir(parents=True, exist_ok=True)
    (state / "ledger-spool").mkdir(parents=True, exist_ok=True)
    path = state / "ledger.db"
    db.ensure(path, home / "backups", stamp(0))
    conn = db.connect(path)
    machine = db.machine_id(conn)
    conn.execute(
        "INSERT INTO graph_runs (run_id, machine_id, graph_id, graph_source, graph_version, subject_kind, subject_ref, "
        "tracker, ticket_key, phi, runner, started_at, recorded_by) VALUES (?, ?, 'development', 'graph-file', 'abc', "
        "'ticket', 'JP-901', 'jira', 'JP-901', 0, 'agent-manager', ?, 'test')", (RUN, machine, stamp(1)))
    conn.execute("INSERT INTO step_runs (run_id, step_id, step_kind, attempt, loop_count, tier, role, started_at, "
                 "recorded_by) VALUES (?, 'build', 'role', 1, 0, 'mid', 'builder', ?, 'test')", (RUN, stamp(2)))
    conn.execute("INSERT INTO step_results (step_run_id, outcome, model, ended_at, recorded_by) "
                 "VALUES (1, '_abandoned', NULL, ?, 'test')", (stamp(5),))
    conn.execute("INSERT INTO step_runs (run_id, step_id, step_kind, attempt, loop_count, tier, role, started_at, "
                 "recorded_by) VALUES (?, 'verify_build', 'gate', 1, 0, NULL, NULL, ?, 'test')", (RUN, stamp(6)))
    conn.execute("INSERT INTO step_results (step_run_id, outcome, model, note, ended_at, recorded_by) "
                 "VALUES (2, 'passed', NULL, 'suite green, 412 tests', ?, 'test')", (stamp(7),))
    conn.execute("INSERT INTO step_runs (run_id, step_id, step_kind, attempt, loop_count, tier, role, started_at, "
                 "recorded_by) VALUES (?, 'approve', 'ask', 1, 0, NULL, NULL, ?, 'test')", (RUN, stamp(8)))
    conn.execute("INSERT INTO asks (ask_id, run_id, step_run_id, category, question_key, tracker, ticket_key, "
                 "question, stage, channel, asked_at, recorded_by) VALUES ('ask-1', ?, 3, 'development/approve', "
                 "'development/approve', 'jira', 'JP-901', 'Merge the sample change?', 1, 'needs-you', ?, 'test')",
                 (RUN, stamp(8, 30)))
    conn.close()

    (logs / "runner" / "runner.log").write_text(
        "{} tick: started advance for {}\n{} advance {}: started build attempt 1\n"
        "{} advance {}: abandoned build attempt 1: rested-without-result\n".format(
            stamp(1, 30), RUN, stamp(2, 5), RUN, stamp(5, 1), RUN), encoding="utf-8")
    (logs / "runner" / "run-{}.log".format(RUN2)).write_text("walker: next step is triage\n", encoding="utf-8")
    (logs / "ledger-record.log").write_text(
        "=== {} exit 0\n{} stopped at the 150s budget; the next run carries on\n".format(stamp(3), stamp(3, 40)),
        encoding="utf-8")
    (logs / "doctor.log").write_text(
        "=== {} exit 1\nTraceback (most recent call last):\n  File \"doctor.py\", line 1\nValueError: sample\n"
        "line four\nline five\n".format(stamp(9)), encoding="utf-8")
    (logs / "graph-runner.log").write_text("=== {} exit 0\n(report output, 120 bytes)\n".format(stamp(4)),
                                           encoding="utf-8")
    (logs / "hooks.log").write_text("{} PreToolUse 20-graph-step-guard blocked (exit 2)\n".format(stamp(10)),
                                    encoding="utf-8")
    spool = state / "ledger-spool" / "2026-11-20.jsonl"
    spool.write_text(json.dumps({"event": "SessionStart", "at": stamp(0, 30), "session_id": "sess-0001-abcdef",
                                 "cwd": "/tmp/sample/josh-360", "source": "startup",
                                 "started_by": "agent-manager"}) + "\n", encoding="utf-8")
    return home


if __name__ == "__main__":
    print(build(Path(sys.argv[1]).absolute()))
