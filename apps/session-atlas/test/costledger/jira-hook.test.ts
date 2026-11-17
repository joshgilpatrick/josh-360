import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openTestLedger } from '../helpers/costledger.ts'
import { jiraIssueKeysFromCommand, recordJiraHookLinks } from '../../src/costledger/jira-hook.ts'

const NOW = '2026-10-11T00:00:00.000Z'

test('a transition names its issue key', () => {
  assert.deepEqual(jiraIssueKeysFromCommand('acli jira workitem transition --key AD-12 --status "In Progress" --yes'), ['AD-12'])
})

test('a comment create names its issue key', () => {
  assert.deepEqual(jiraIssueKeysFromCommand('acli jira workitem comment create --key AD-7 --body "done"'), ['AD-7'])
})

test('a comment with no subcommand is logged, the form acli examples use', () => {
  assert.deepEqual(jiraIssueKeysFromCommand('acli jira workitem comment --key AD-7 --body "done"'), ['AD-7'])
})

test('a comment update is logged', () => {
  assert.deepEqual(jiraIssueKeysFromCommand('acli jira workitem comment update --key AD-7 --body "fixed"'), ['AD-7'])
})

test('edit, create, view, and search are not logged', () => {
  assert.deepEqual(jiraIssueKeysFromCommand('acli jira workitem edit --key AD-1 --summary "typo"'), [])
  assert.deepEqual(jiraIssueKeysFromCommand('acli jira workitem create --summary "x" --project AD'), [])
  assert.deepEqual(jiraIssueKeysFromCommand('acli jira workitem view AD-1 --json'), [])
  assert.deepEqual(jiraIssueKeysFromCommand('acli jira workitem search --jql "project = AD"'), [])
})

test('read-only comment subcommands are not logged', () => {
  assert.deepEqual(jiraIssueKeysFromCommand('acli jira workitem comment list --key AD-1'), [])
  assert.deepEqual(jiraIssueKeysFromCommand('acli jira workitem comment delete --key AD-1'), [])
})

test('multiple keys in one command are each logged once', () => {
  assert.deepEqual(jiraIssueKeysFromCommand('acli jira workitem transition --key "AD-1,AD-2,AD-1" --status Done'), ['AD-1', 'AD-2'])
})

test('a key flag on a different command in a chain is not picked up', () => {
  const cmd = 'acli jira workitem edit --key AD-9 --summary x && acli jira workitem transition --key AD-3 --status Done'
  assert.deepEqual(jiraIssueKeysFromCommand(cmd), ['AD-3'])
})

test('--jql and --filter do not name keys, so they add nothing', () => {
  assert.deepEqual(jiraIssueKeysFromCommand('acli jira workitem transition --jql "project = AD" --status Done'), [])
  assert.deepEqual(jiraIssueKeysFromCommand('acli jira workitem transition --filter 10001 --status Done'), [])
})

test('a non-Jira Bash command is ignored', () => {
  assert.deepEqual(jiraIssueKeysFromCommand('echo "transition --key AD-1"'), [])
})

test('an acli command quoted inside echo is not logged', () => {
  assert.deepEqual(jiraIssueKeysFromCommand("echo 'acli jira workitem transition --key AD-1 --status Done'"), [])
})

test('an acli command quoted inside a commit message is not logged', () => {
  assert.deepEqual(jiraIssueKeysFromCommand("git commit -m 'acli jira workitem comment --key AD-2 --body x'"), [])
})

test('an acli command quoted inside a JSON payload is not logged', () => {
  assert.deepEqual(jiraIssueKeysFromCommand(`printf '%s' '{"command":"acli jira workitem transition --key AD-3 --status Done"}'`), [])
})

test('a quoted body containing a separator does not hide a later key', () => {
  assert.deepEqual(jiraIssueKeysFromCommand('acli jira workitem comment --key AD-4 --body "a; b --key AD-5"'), ['AD-4'])
})

test('an acli call after a variable assignment is logged', () => {
  assert.deepEqual(jiraIssueKeysFromCommand('JIRA_DEBUG=1 acli jira workitem transition --key AD-6 --status Done'), ['AD-6'])
})

test('an acli call given by full path is logged', () => {
  assert.deepEqual(jiraIssueKeysFromCommand('/opt/bin/acli jira workitem transition --key AD-7 --status Done'), ['AD-7'])
})

test('an acli call after && is logged, and a key in a quoted string is not', () => {
  assert.deepEqual(jiraIssueKeysFromCommand('cd x && acli jira workitem transition --key AD-8 --status Done'), ['AD-8'])
})

test('a variable key is not a Jira key, so it adds nothing', () => {
  assert.deepEqual(jiraIssueKeysFromCommand('acli jira workitem transition --key $KEY --status Done'), [])
})

test('recording writes one row per issue for the parent session', () => {
  const db = openTestLedger()
  const keys = recordJiraHookLinks(db, {
    session_id: 'parent-1',
    tool_name: 'Bash',
    tool_input: { command: 'acli jira workitem comment --key AD-5 --body hi' },
    tool_response: { stdout: '{"id":"10001"}', stderr: '' },
  }, NOW)
  assert.deepEqual(keys, ['AD-5'])
  const rows = db.raw.prepare('SELECT issue_key, tool, source_session_id, action FROM jira_session_links').all() as Array<Record<string, unknown>>
  assert.equal(rows.length, 1)
  assert.deepEqual({ ...rows[0] }, { issue_key: 'AD-5', tool: 'claude-code', source_session_id: 'parent-1', action: 'worked' })
  db.close()
})

test('recording ignores non-Bash tools and payloads with no session', () => {
  const db = openTestLedger()
  assert.deepEqual(recordJiraHookLinks(db, { session_id: 's', tool_name: 'Edit', tool_input: { command: 'acli jira workitem transition --key AD-1' } }, NOW), [])
  assert.deepEqual(recordJiraHookLinks(db, { tool_name: 'Bash', tool_input: { command: 'acli jira workitem transition --key AD-1' } }, NOW), [])
  assert.deepEqual(recordJiraHookLinks(db, { session_id: '', tool_name: 'Bash', tool_input: { command: 'acli jira workitem transition --key AD-1' } }, NOW), [])
  const n = (db.raw.prepare('SELECT COUNT(*) c FROM jira_session_links').get() as { c: number }).c
  assert.equal(n, 0)
  db.close()
})

test('recording the same issue twice in one session keeps one row', () => {
  const db = openTestLedger()
  const payload = { session_id: 's1', tool_name: 'Bash', tool_input: { command: 'acli jira workitem transition --key AD-2 --status Done' }, tool_response: { stdout: '{}', stderr: '' } }
  recordJiraHookLinks(db, payload, NOW)
  recordJiraHookLinks(db, payload, NOW)
  const n = (db.raw.prepare('SELECT COUNT(*) c FROM jira_session_links').get() as { c: number }).c
  assert.equal(n, 1)
  db.close()
})

const TRANSITION = 'acli jira workitem transition --key AD-30 --status Done --yes'

test('an acli failure line means nothing is logged, even with exit 0', () => {
  const db = openTestLedger()
  const keys = recordJiraHookLinks(db, {
    session_id: 's-fail', tool_name: 'Bash', tool_input: { command: TRANSITION },
    tool_response: { stdout: "✗ Failure: AD-30 can't be transitioned: Issue does not exist", stderr: '' },
  }, NOW)
  assert.deepEqual(keys, [])
  const n = (db.raw.prepare('SELECT COUNT(*) c FROM jira_session_links').get() as { c: number }).c
  assert.equal(n, 0)
  db.close()
})

test('an acli error line in stdout also means nothing is logged', () => {
  const db = openTestLedger()
  assert.deepEqual(recordJiraHookLinks(db, {
    session_id: 's-err', tool_name: 'Bash', tool_input: { command: TRANSITION },
    tool_response: { stdout: '✗ Error: Issue does not exist', stderr: '' },
  }, NOW), [])
  db.close()
})

test('a successful call with output is logged', () => {
  const db = openTestLedger()
  assert.deepEqual(recordJiraHookLinks(db, {
    session_id: 's-ok', tool_name: 'Bash', tool_input: { command: TRANSITION },
    tool_response: { stdout: '{"key":"AD-30"}', stderr: '' },
  }, NOW), ['AD-30'])
  db.close()
})

test('missing output fails closed and logs nothing', () => {
  const db = openTestLedger()
  assert.deepEqual(recordJiraHookLinks(db, { session_id: 's-none', tool_name: 'Bash', tool_input: { command: TRANSITION } }, NOW), [])
  db.close()
})

test('the tool_output field name is read too, matching the secret-redact hook', () => {
  const db = openTestLedger()
  assert.deepEqual(recordJiraHookLinks(db, {
    session_id: 's-out', tool_name: 'Bash', tool_input: { command: TRANSITION },
    tool_output: { stdout: '{"key":"AD-30"}', stderr: '' },
  }, NOW), ['AD-30'])
  db.close()
})
