import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEvent, EventValidationError, isValidSessionId } from '../../src/ingest/event.ts'

const SID = '2864efe7-6e70-4357-9e2f-a4ef9a4f33db'

test('parses a minimal turn_completed event', () => {
  const e = parseEvent({ event: 'turn_completed', session_id: SID, ts: '2026-09-17T01:02:03.000Z', fingerprint: 'abc',
    transcript_path: '/Users/x/.claude/projects/p/' + SID + '.jsonl', cwd: '/Users/x/dev' })
  assert.equal(e.event, 'turn_completed')
  assert.equal(e.session_id, SID)
})

test('rejects unknown event types and bad session ids', () => {
  assert.throws(() => parseEvent({ event: 'nope', session_id: SID, ts: 'x', fingerprint: 'f' }), EventValidationError)
  assert.throws(() => parseEvent({ event: 'turn_completed', session_id: '../etc', ts: 'x', fingerprint: 'f' }), EventValidationError)
  assert.throws(() => parseEvent({ event: 'turn_completed', session_id: SID, ts: 'x' }), EventValidationError)
})

test('drops unknown fields and non-string optionals', () => {
  const e = parseEvent({ event: 'tool_completed', session_id: SID, ts: 'x', fingerprint: 'f', tool_name: 'Write', created_path: 5, secret: 'no' })
  assert.equal(e.tool_name, 'Write')
  assert.equal(e.created_path, undefined)
  assert.equal((e as Record<string, unknown>).secret, undefined)
})

test('parent_session_id is kept when valid', () => {
  const e = parseEvent({ event: 'tool_completed', session_id: 'agent-ae6334ea7304760ee', parent_session_id: SID, ts: 'x', fingerprint: 'f' })
  assert.equal(e.parent_session_id, SID)
})

test('rejects invalid parent_session_id', () => {
  assert.throws(() => parseEvent({ event: 'tool_completed', session_id: 'agent-abc123', parent_session_id: '../../etc/passwd', ts: 'x', fingerprint: 'f' }), EventValidationError)
})

test('subagent ids are valid session ids', () => {
  assert.ok(isValidSessionId('agent-ae6334ea7304760ee'))
  assert.ok(isValidSessionId(SID))
  assert.ok(!isValidSessionId('agent-'))
  assert.ok(!isValidSessionId('Agent-ZZZ'))
})

test('rejects invalid agent_id', () => {
  assert.throws(() => parseEvent({ event: 'subagent_stop', session_id: SID, agent_id: 'not hex!', ts: 'x', fingerprint: 'f' }), EventValidationError)
})

test('accepts a valid agent_id', () => {
  const e = parseEvent({ event: 'subagent_stop', session_id: SID, agent_id: 'ae6334ea7304760ee', ts: 'x', fingerprint: 'f' })
  assert.equal(e.agent_id, 'ae6334ea7304760ee')
})

// C1 defence in depth: a transcript_path whose basename doesn't name THIS event's own
// session_id must never be stored -- e.g. a re-keyed subagent event still carrying the
// parent's transcript_path (see hooks/atlas-hook.js). The rest of the event is kept.
test('drops a transcript_path that does not match this event\'s own session_id', () => {
  const e = parseEvent({
    event: 'tool_completed', session_id: 'agent-ae6334ea7304760ee', parent_session_id: SID,
    ts: 'x', fingerprint: 'f', tool_name: 'Read', transcript_path: `/Users/x/.claude/projects/p/${SID}.jsonl`,
  })
  assert.equal(e.transcript_path, undefined)
  assert.equal(e.tool_name, 'Read', 'the rest of the event is kept')
})

test('keeps a transcript_path whose basename matches its own session_id', () => {
  const e = parseEvent({
    event: 'turn_completed', session_id: 'agent-ae6334ea7304760ee', ts: 'x', fingerprint: 'f',
    transcript_path: '/Users/x/.claude/projects/p/parent-sid/subagents/agent-ae6334ea7304760ee.jsonl',
  })
  assert.equal(e.transcript_path, '/Users/x/.claude/projects/p/parent-sid/subagents/agent-ae6334ea7304760ee.jsonl')
})
