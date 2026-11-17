import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ledger_transcripts as tr  # noqa: E402
from ledger_helpers import LedgerCase  # noqa: E402
from ledger import transcript  # noqa: E402


class ReadMetaTests(LedgerCase):
    def tpath(self, name="sess-0001.jsonl"):
        return self.tmp / "projects" / "-made-up" / name

    def test_read_meta_never_returns_message_text(self):
        p = tr.write(self.tpath(), tr.plain("/tmp/made-up/josh_360", title="Made up title"))
        meta = transcript.read_meta(p)
        text = repr(meta)
        self.assertNotIn(tr.USER_TEXT, text)
        self.assertNotIn(tr.ASSISTANT_TEXT, text)
        self.assertEqual(meta.session_id, "sess-0001")
        self.assertEqual(meta.cwd, "/tmp/made-up/josh_360")
        self.assertEqual(meta.branch, "JP-900/sample-work")
        self.assertEqual(meta.first_at, "2026-11-17T09:00:00Z")
        self.assertEqual(meta.last_at, "2026-11-17T09:10:00Z")
        self.assertEqual(meta.turns, 2)

    def test_titles_follow_atlas_order(self):
        p = tr.write(self.tpath(), [
            tr.line("agent-name", "2026-11-17T09:00:00Z", agentName="the agent name"),
            tr.line("ai-title", "2026-11-17T09:00:01Z", aiTitle="the ai title"),
            tr.line("custom-title", "2026-11-17T09:00:02Z", customTitle="the custom title")])
        meta = transcript.read_meta(p)
        self.assertEqual(meta.titles, {"agent-name": "the agent name", "ai": "the ai title",
                                       "custom": "the custom title"})
        self.assertEqual(transcript.best_title(meta.titles), ("the custom title", "custom"))
        self.assertEqual(transcript.best_title({"ai": "x", "agent-name": "y"}), ("x", "ai"))
        self.assertEqual(transcript.best_title({}), (None, None))

    def test_bad_lines_are_skipped_and_counted(self):
        good = tr.plain("/tmp/made-up/josh_360")
        p = self.tpath()
        p.parent.mkdir(parents=True, exist_ok=True)
        big = json.dumps({"type": "user", "timestamp": "2026-11-17T09:00:30Z", "pad": "x" * 1_100_000})
        with p.open("w", encoding="utf-8") as f:
            f.write(good[0] + "\n{not json\n" + big + "\n")
            f.write("\n".join(good[1:]) + "\n")
            f.write('{"type": "assistant", "timest')  # truncated last line: still being written
        meta = transcript.read_meta(p)
        self.assertEqual(meta.skipped_lines, 2)
        raw = p.read_bytes()
        self.assertEqual(meta.end_offset, raw.rindex(b"\n") + 1)
        with p.open("a", encoding="utf-8") as f:
            f.write('amp": "2026-11-17T09:20:00Z"}\n')
        again = transcript.read_meta(p, since_offset=meta.end_offset)
        self.assertEqual(again.lines_read, 1)
        self.assertEqual(again.last_at, "2026-11-17T09:20:00Z")

    def test_relative_cwd_is_ignored(self):
        p = tr.write(self.tpath(), [tr.line("user", "2026-11-17T09:00:00Z", cwd="../elsewhere")])
        self.assertIsNone(transcript.read_meta(p).cwd)

    def test_reads_only_from_the_offset(self):
        p = tr.write(self.tpath(), tr.plain("/tmp/made-up/josh_360"))
        first = transcript.read_meta(p)
        tr.append(p, [tr.line("assistant", "2026-11-17T11:00:00Z", cwd="/tmp/made-up/other")])
        second = transcript.read_meta(p, since_offset=first.end_offset)
        self.assertEqual((second.lines_read, second.first_at, second.cwd), (1, "2026-11-17T11:00:00Z",
                                                                            "/tmp/made-up/other"))

    def test_pull_requests_and_created_files_are_collected(self):
        p = tr.write(self.tpath(), tr.plain("/tmp/made-up/josh_360", pr=("https://example.test/o/r/pull/9", "o/r"),
                                           created=["/tmp/made-up/a.md", "/tmp/made-up/a.md", "relative.md"]))
        meta = transcript.read_meta(p)
        self.assertEqual(meta.pr_urls, [("https://example.test/o/r/pull/9", "o/r")])
        self.assertEqual(meta.files_created, ["/tmp/made-up/a.md"])

    def test_subagent_file_belongs_to_the_parent_folder(self):
        p = self.tpath("sess-0001/subagents/agent-ab12.jsonl")
        self.assertEqual(transcript.subagent_of(p), ("sess-0001", "agent-ab12"))
        self.assertIsNone(transcript.subagent_of(self.tpath()))


if __name__ == "__main__":
    unittest.main()
