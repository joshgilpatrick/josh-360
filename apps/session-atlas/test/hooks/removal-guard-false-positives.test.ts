import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tempDir } from '../helpers/tmp.ts'

// JP-157: the removal guard blocks only commands that delete, move or prune something, and names the cause. Quoted text is read
// as code only when something runs it. The real guard script is spawned with a made-up payload and judged by exit code and
// stderr; no command under test is ever run. The existing guard tests (artifact-removal-guard.test.ts) are unchanged.

const GUARD = fileURLToPath(new URL('../../hooks/atlas-removal-guard.js', import.meta.url))
const PATH_ENV = process.env.PATH ?? '/usr/bin:/bin'
const GIT_HOME = realpathSync(tempDir('atlas-guard-fp-githome-'))
const GIT_ENV = {
  PATH: PATH_ENV, HOME: GIT_HOME, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Atlas Test', GIT_AUTHOR_EMAIL: 'atlas@example.invalid', GIT_COMMITTER_NAME: 'Atlas Test', GIT_COMMITTER_EMAIL: 'atlas@example.invalid',
}
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV }).trim()

function makeRepo(dir: string): string {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'README.md'), '# readme\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'initial')
  return realpathSync(dir)
}

/** home/work/proj (main checkout), home/work/proj-wt (linked worktree), home/many with 10 other repositories, home/plain (no repository). */
function makeLayout() {
  const home = realpathSync(tempDir('atlas-guard-fp-home-'))
  const work = join(home, 'work')
  const main = makeRepo(join(work, 'proj'))
  git(main, 'worktree', 'add', '-q', '-b', 'wt', join(work, 'proj-wt'))
  const wt = realpathSync(join(work, 'proj-wt'))
  git(main, 'worktree', 'add', '-q', '-b', 'wt2', join(work, 'worktree-two'))
  const named = realpathSync(join(work, 'worktree-two'))
  const many = join(home, 'many')
  for (let i = 0; i < 10; i++) makeRepo(join(many, `repo${i}`))
  const plain = join(home, 'plain')
  mkdirSync(plain)
  return { home, work, main, wt, named, many: realpathSync(many), plain }
}
const layout = makeLayout()

type Outcome = { code: number | null; stderr: string }

function guard(command: string, cwd = layout.main): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    const env = { PATH: PATH_ENV, HOME: layout.home, ATLAS_PORT: '9' }
    const child = spawn(process.execPath, [GUARD], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.setEncoding('utf8').on('data', (c: string) => { stderr += c })
    const killer = setTimeout(() => child.kill('SIGKILL'), 30_000)
    after(() => clearTimeout(killer))
    child.on('error', reject)
    child.on('close', code => { clearTimeout(killer); resolve({ code, stderr }) })
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify({
      session_id: '2864efe7-6e70-4357-9e2f-a4ef9a4f33db', transcript_path: '/t/session.jsonl', cwd, hook_event_name: 'PreToolUse',
      tool_name: 'Bash', tool_input: { command, description: 'test' },
    }))
  })
}

async function each<T>(items: T[], fn: (item: T) => Promise<void>, limit = 6): Promise<void> {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) await fn(items[next++]!) }))
}

const { wt, named, main, work, many, home } = layout

test('JP-157: commands that delete nothing pass, whatever words they quote', async () => {
  const commands = [
    'echo "remove the worktree"',
    'git commit -m "remove the worktree helper"',
    'git -C ' + main + ' commit -m "remove the worktree helper"',
    'gh api "repos/o/r/contents/x?ref=worktree-name"',
    'gh pr create --title "remove worktree guard false blocks" --body "prune the worktree docs"',
    'python3 scripts/sprint.py handoff --note "the worktree is done"',
    `python3 tool.py --root ${many} --note "see worktree docs"`,
    `find ${many} -maxdepth 1 -name "*.md"`,
    `ls ${many} "remove the worktree"`,
    `echo "remove the worktree" && ls ${wt}`,
    `printf '%s' 'remove the worktree' ; git log --oneline`,
    `cd ${wt} && git commit -m "worktree remove notes"`,
  ]
  await each(commands, async command => {
    const r = await guard(command)
    assert.equal(r.code, 0, `${command}: expected exit 0\n${r.stderr}`)
  })
})

test('JP-157: a command with no deleting word skips the checkout-count rule for a folder of many repositories', async () => {
  for (const command of [`python3 tool.py --root ${many} --note "see worktree docs"`, `node build.js ${many} ${home} --verbose`]) {
    const r = await guard(command)
    assert.equal(r.code, 0, `${command}\n${r.stderr}`)
  }
  // The same folder with a real deletion keeps its checkout-count block.
  const r = await guard(`rm -rf ${many}`)
  assert.equal(r.code, 2, 'a deletion of a folder holding 10 repositories is still checked')
})

test('JP-157: every real deletion that was blocked stays blocked', async () => {
  const commands = [
    `git worktree remove --force ${wt}`,
    `rm -rf ${wt}`,
    `rm -rf ${work}`,
    `rm -rf ${main}`,
    'rm -rf "$HOME"',
    `bash -c "rm -rf ${wt}"`,
    `sh -c 'rm -rf ${wt}'`,
    `(rm -rf ${wt})`,
    `sudo rm -rf ${wt}`,
    `find ${work} -exec rm -rf {} +`,
    `eval "rm -rf ${wt}"`,
    `echo "$(rm -rf ${wt})"`,
    'echo "remove the worktree" && rm -rf ' + wt,
    `mv ${wt} ${home}/elsewhere`,
    `python3 -c "import shutil; shutil.rmtree('${wt}')"`,
    `python3 -c "import os; os.rmdir('${wt}')"`,
    `node -e "require('fs').rmSync('${wt}',{recursive:true})"`,
    `ruby -e "FileUtils.rm_rf('${wt}')"`,
    `ruby -e "FileUtils.rm_r('${wt}')"`,
    `perl -e "unlink('${wt}')"`,
    `echo "rm -rf ${wt}" | sh`,
    `echo "rm -rf ${wt}" > /tmp/jp157-script.sh`,
    `x=rm; $x -rf ${wt}`,
    `bash cleanup.sh ${named}`,
    `sh -c "$cleanup" ${named}`,
  ]
  await each(commands, async command => {
    const r = await guard(command)
    assert.equal(r.code, 2, `${command}: expected exit 2\n${r.stderr}`)
  })
})

test('JP-157: a block names the verb and the path that caused it', async () => {
  const direct = await guard(`rm -rf ${wt}`)
  assert.equal(direct.code, 2)
  assert.match(direct.stderr, /rm would delete/)
  assert.ok(direct.stderr.includes(JSON.stringify(wt)), `names the worktree path\n${direct.stderr}`)

  const nested = await guard(`bash -c "rm -rf ${wt}"`)
  assert.equal(nested.code, 2)
  assert.ok(nested.stderr.includes(JSON.stringify(wt)), `names the worktree path\n${nested.stderr}`)
  assert.match(nested.stderr, /"rm"/, 'names the verb')

  const moved = await guard(`mv ${wt} ${home}/elsewhere`)
  assert.equal(moved.code, 2)
  assert.match(moved.stderr, /"mv"/, 'names the verb')
  assert.ok(moved.stderr.includes(JSON.stringify(wt)), `names the worktree path\n${moved.stderr}`)

  const prose = await guard('echo "remove the worktree" > notes.txt')
  assert.equal(prose.code, 2, 'text sent to a file or another command may be run later, so it is still read as code')
  assert.match(prose.stderr, /removes or prunes Git worktrees/)
  assert.match(prose.stderr, /remove the worktree/, 'shows the command that matched')
})

// JP-197: a `[` inside quoted code or a `[:N]` slice is not a glob over a worktree; a real glob that matches one still blocks.
test('JP-197: a slice in a piped one-liner is allowed', async () => {
  const commands = [
    // JP-116's run: the laptop's own read of `git worktree list` output, blocked on 20 November.
    `cat f | python3 -c 'import sys,json; [print(r["worktree"][:40]) for r in json.load(sys.stdin)[:3]]'`,
    `cat ${main}/README.md | python3 -c "import sys, json; d = sys.stdin.read(); print(d[:3])"`,
    `echo '{"a": [1, 2, 3]}' | python3 -c "import json, sys; print(json.load(sys.stdin)['a'][:2])"`,
    `ls ${work} | head -n 3`,
  ]
  await each(commands, async command => {
    const r = await guard(command)
    assert.equal(r.code, 0, `${command}: expected exit 0\n${r.stderr}`)
  })
})

test('JP-197: a glob that matches the worktree folder still blocks', async () => {
  const repo = makeRepo(join(home, 'dotted'))
  git(repo, 'worktree', 'add', '-q', '-b', 'inner', join(repo, '.claude', 'worktrees', 'inner'))
  for (const command of ['rm -rf [.]claude', 'rm -rf .clau?e', `rm -rf ${repo}/.claude/work*`, 'rm -rf .claude/worktrees/[a-z]*']) {
    const r = await guard(command, repo)
    assert.equal(r.code, 2, `${command}: expected exit 2\n${r.stderr}`)
  }
})

test('JP-197: a star glob over a worktree\'s parent still blocks', async () => {
  for (const command of ['rm -rf ../proj*', `rm -rf ${work}/proj-*`, `rm -rf ${work}/*`, 'rm -rf ../worktree-?wo']) {
    const r = await guard(command)
    assert.equal(r.code, 2, `${command}: expected exit 2\n${r.stderr}`)
  }
  // A glob that matches no worktree path is not blocked for being a glob.
  const r = await guard(`rm -rf ${home}/plain/*.tmp`)
  assert.equal(r.code, 0, r.stderr)
})
