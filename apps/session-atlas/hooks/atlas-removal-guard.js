#!/usr/bin/env node
'use strict'
// Atlas worktree removal guard (plan 2026-10-26 Task 12; spec s11 "Hook integration and limits"). A Claude Code PreToolUse hook
// for the Bash tool that stands between an agent and `git worktree remove` or `rm` of a Git worktree.
//
// Fail-closed. Claude Code blocks a tool call only when a PreToolUse hook exits 2 (stderr is shown to the model); any other exit
// code, a crash included, lets the command run. So every failure on a command that may concern a worktree ends in an explicit
// exit 2 with a reason and a next step: unreadable input, the deadline, an analysis or checker failure, an uncaught exception.
//
// This is a guard for the supported agent workflow, not an OS-level protection boundary: other terminals, programs and filesystem
// APIs are not intercepted, and a target computed at run time (a variable, a command substitution) is judged by its text only.
//
// Flow, under one 10 s wall deadline from process start (the settings entry gives Claude Code's own hook timeout as 15 s, so the
// guard's block message, not a hook timeout, decides):
//   1. stdin: one JSON payload, at most 4 MiB. Unreadable input exits 2, because the guard cannot tell what would run.
//   2. relevance: a marker test (isRelevant) on a copy of the command with the shell's quote removal and line continuation undone
//      (r''m, 'r'm, r\m and r\<newline>m are all rm). A command without a marker exits 0 at once; that path loads no other
//      module, reads no file and starts no process. A relevant command holding a NUL character, or longer than 64 KiB, blocks
//      at once (the analysis stays linear and bounded).
//   3. analysis, in a child process (this script with ANALYZE_FLAG): the strict grammar, path resolution, Git's worktree list
//      through the Atlas Git adapter (src/artifacts/git.ts) and, for a folder outside every known worktree, the Atlas catalog
//      read-only (registered checkout roots below it). It is a child because a filesystem call that hangs (a network mount, a
//      FIFO) cannot be interrupted, and a blocked thread-pool request even keeps process.exit() from returning. This process
//      itself does no filesystem work, so its deadline always ends in exit 2.
//   4. for an accepted `git worktree remove`, the standalone checker (`npm run artifacts -- check-removal --json`) in a second
//      child, in its own process group, from the session's directory, so it can see a caller standing inside the target. The
//      removal is allowed only when the checker exits 0 AND its JSON answer agrees. At the deadline both process groups are killed.
//      Tests replace the checker only with the CHECKER_FLAG argument on this script's command line (ruling R59): the installer
//      never writes it, and nothing in the environment can.
//
// Accepted grammar (ruling R55). Words are separated by spaces or tabs and are plain text or single/double-quoted literals.
// Escapes, control characters (newline included), `$`, backticks, glob and brace characters, `~`, redirection, pipes, `;`, `&`,
// parentheses, `#`, `!`, `^` and assignment words are rejected before any word is interpreted. Exactly two forms are accepted:
//   git [-C DIR] worktree remove [--] PATH     DIR relative to the session directory, PATH relative to DIR (else to the session
//                                             directory), as Git resolves them; any other option or word is not accepted
//   rm [-r|-R|-rf|-fr] PATH
// The accepted git form must name one registered linked worktree unambiguously (ruling R56: Git also matches a relative PATH by a
// unique suffix of a worktree's path), and is then checked. The accepted rm form is blocked when PATH is a registered worktree
// or an ancestor of one, and always when it is the home folder or an ancestor of it. Worktrees are those of the session
// directory's repository, of PATH's repository, of checkouts directly below PATH, and the checkout roots the Atlas catalog
// registers below PATH. Otherwise it is allowed. Everything else (rulings R57, R58, R60) is blocked for manual resolution only
// when its text appears to target a managed worktree or the home folder (see appearsToTarget). The operands of a directory change
// (cd, pushd, -C, --work-tree) do not count by themselves; they become the base of later relative words. A plain
// `git worktree list|prune|move|lock|unlock|repair|add` is out of scope.
//
// Known limits (documented, not intercepted): a command name computed in the middle of a word (`a${c}m`), a target computed by
// a command other than pwd or `git rev-parse --show-toplevel`, deletion through a program that names no path in the command,
// and a worktree more than one folder below a target when the Atlas catalog does not register it.
// JP-157 (decisions/JP-157.md): the "appears to target" rules apply only to a command with a deleting or moving word (rm, rmdir, unlink,
// shred, trash, srm, rimraf, rmtree, -delete, -exec, git clean, mv, a computed command name, a shell or eval); any other command is
// allowed. Quoted text after a command that does not run it (echo, printf, git commit, gh, an interpreter without -c/-e) is data and
// is not inspected, unless its output goes to a pipe, a redirection or a substitution, or it holds $( ) or a backtick.

const fs = require('node:fs')
const path = require('node:path')

const DEADLINE_MS = 10_000
const MAX_STDIN_BYTES = 4 * 1024 * 1024
const MAX_COMMAND_BYTES = 64 * 1024
const MAX_DECISION_CHARS = 256 * 1024
const MAX_CHECKER_STDOUT_BYTES = 1024 * 1024
const CHECKER_TIMEOUT_MS = '8000'
const MAX_ISSUES_SHOWN = 5
// Every printed line is cut to this; every path or checker text in it to MAX_SHOWN_CHARS, and at most MAX_NAMES_SHOWN paths are listed.
const MAX_LINE_CHARS = 1000
const MAX_SHOWN_CHARS = 300
const MAX_NAMES_SHOWN = 3
const MAX_TOKENS = 10_000
// Folders named by a command whose repositories are listed, beyond the session directory's (each costs a few Git processes).
const MAX_ANCHORS = 8
// A folder with more entries than this is not scanned for checkouts directly below it (dependency and cache folders).
const MAX_SCAN_ENTRIES = 256
const MAX_CHILD_CHECKOUTS = 8
const ANALYZE_FLAG = '--atlas-removal-guard-analyze'
const CHECKER_FLAG = '--checker-for-tests'
const ATLAS_ROOT = path.resolve(__dirname, '..')
const DEFAULT_CHECKER = path.join(ATLAS_ROOT, 'src', 'cli', 'artifacts.ts')
const GIT_ADAPTER = path.join(ATLAS_ROOT, 'src', 'artifacts', 'git.ts')
const CONFIG_MODULE = path.join(ATLAS_ROOT, 'src', 'config.ts')
const CATALOG_MODULE = path.join(ATLAS_ROOT, 'src', 'db', 'artifact-manager.ts')
const LIMITS = Object.freeze({ deadlineMs: DEADLINE_MS, maxStdinBytes: MAX_STDIN_BYTES, checkerTimeoutMs: Number(CHECKER_TIMEOUT_MS), maxCheckerStdoutBytes: MAX_CHECKER_STDOUT_BYTES })

// -------------------------------------------------------------------------------------------------------------- text

const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/g

/** Text safe for one terminal line: control characters (C0, DEL, C1, newline and ESC included), line separators and bidi marks become `?`. */
function sanitize(value) {
  return String(value).replace(UNSAFE_TEXT, '?')
}

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text
}

/** A path as one shell word in guidance text. */
function shellWord(p) {
  const text = clip(String(p), MAX_SHOWN_CHARS)
  return /^[A-Za-z0-9_./+@%:,-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`
}

/** A path or a checker text as delimited data: JSON-quoted (control characters escaped) and bounded. */
function quoted(value) {
  return JSON.stringify(clip(String(value), MAX_SHOWN_CHARS))
}

/** At most MAX_NAMES_SHOWN quoted paths, and how many more there are. */
function names(paths) {
  const shown = paths.slice(0, MAX_NAMES_SHOWN).map(quoted).join(' or ')
  return paths.length > MAX_NAMES_SHOWN ? `${shown} and ${paths.length - MAX_NAMES_SHOWN} more` : shown
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ---------------------------------------------------------------------------------------------------------- guidance

const NEXT_RETRY = 'run the command again; if it is blocked again, ask the user to run it.'
const NEXT_MAIN = 'do not delete or remove a main checkout from an agent session; ask the user.'
const NEXT_HOME = 'never delete the home folder or a folder that contains it from an agent session; ask the user.'

/** The supported check-and-normal-remove flow for one worktree. */
function removalFlow(target) {
  const t = shellWord(target || '<worktree>')
  return `stop every session that writes in ${t}; from the Atlas checkout (${shellWord(ATLAS_ROOT)}) run "npm run artifacts -- check-removal --worktree ${t}" ` +
    `until it exits 0, then run "git worktree remove ${t}" without --force, so Git's own dirty-worktree checks stay on. ` +
    'Never use --force; a passing check is valid for the next single removal only.'
}

function flowFor(worktree) {
  if (worktree && worktree.home) return NEXT_HOME
  if (worktree && worktree.isMain) return NEXT_MAIN
  if (worktree && worktree.catalog) return `if it is a linked worktree: ${removalFlow(worktree.worktreePath)} If it is a main checkout, ask the user.`
  return removalFlow(worktree ? worktree.worktreePath : null)
}

/** What a protected path is, for messages. */
function kindOf(worktree) {
  if (worktree.home) return 'home folder'
  if (worktree.catalog) return 'registered checkout'
  return worktree.isMain ? 'main checkout' : 'Git worktree'
}

function manualNext(worktree) {
  return `split the command into simple commands the guard can check. To remove a worktree: ${flowFor(worktree)} To delete anything else, run one ` +
    '"rm [-r|-R|-rf|-fr] <literal path>" per command, without variables, globs, pipes or separators. If the command is meant exactly as written, ask the user to run it.'
}

/** One reason line, optional checker lines, one next-step line; every line sanitized and bounded. */
function blockText(code, detail, next, extra) {
  const lines = [`Atlas removal guard blocked this command [${code}]: ${detail}`, ...(extra || []), `Next: ${next}`]
  return `${lines.map(line => clip(sanitize(line), MAX_LINE_CHARS)).join('\n')}\n`
}

// ---------------------------------------------------------------------------------------------------------- relevance

const MARKER_RE = /worktree|\b(?:rm|unlink|shred|trash|srm)|\bmv\b|rimraf|rmtree|-delete\b/i
// A command name that is itself an expansion at the start of a simple command: `$x -rf ...`, `${c}m ...`, `` `cmd` ... ``.
// The blanks after the separator exclude the newline: a newline is a separator of its own, so letting `\s*` consume it as well made
// a run of N newlines cost O(N^2) (C1, final review: 160,000 newlines took 24.8 s, past the hook timeout, which lets the command run).
const DYNAMIC_COMMAND_RE = /(?:^|[;&|(\n])[^\S\n]*[$`]/

/**
 * Whether a command may delete something or concern a worktree (ruling R57 step 1). Linear in the command's length. The markers
 * are read after undoing the shell's own quote removal and line continuation (C1); ANSI-C quoting ($'...') can spell any name and
 * is always inspected; git with remove or prune counts whatever the subcommand is called, since an alias or autocorrection can
 * make it `worktree` (ruling R60).
 */
function isRelevant(command) {
  if (command.includes("$'")) return true
  const text = command.replace(/\\\n/g, '').replace(/[\0'"\\]/g, '')
  if (MARKER_RE.test(text) || DYNAMIC_COMMAND_RE.test(text)) return true
  if (/\bfind\b/i.test(text) && /-exec/i.test(text)) return true
  return /\bgit\b/i.test(text) && /\b(?:clean|remove|prune)\b/i.test(text)
}

// ---------------------------------------------------------------------------------------------------------- the grammar

const UNQUOTED_REJECT = new Set(['\\', '$', '`', '*', '?', '[', ']', '{', '}', '~', '<', '>', '|', '&', ';', '(', ')', '#', '!', '^'])
const DOUBLE_QUOTED_REJECT = /[$`\\!]/
const CONTROL_RE = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/

/** The words of `text` in the accepted grammar, or null when it uses anything else (see the file header). */
function tokenize(text) {
  if (typeof text !== 'string' || CONTROL_RE.test(text)) return null
  const words = []
  let i = 0
  while (i < text.length) {
    if (text[i] === ' ' || text[i] === '\t') { i++; continue }
    const start = i
    let word = ''
    while (i < text.length && text[i] !== ' ' && text[i] !== '\t') {
      const c = text[i]
      if (c === "'" || c === '"') {
        const end = text.indexOf(c, i + 1)
        if (end < 0) return null
        const literal = text.slice(i + 1, end)
        if (c === '"' && DOUBLE_QUOTED_REJECT.test(literal)) return null
        // zsh's RC_QUOTES reads '' inside single quotes as a quote character: the text has two readings, so neither is taken.
        if (c === "'" && text[end + 1] === "'") return null
        word += literal
        i = end + 1
        continue
      }
      if (UNQUOTED_REJECT.has(c)) return null
      // An assignment prefix (X=1 cmd), and zsh's =cmd expansion at the start of a word.
      if (c === '=' && (i === start || words.length === 0)) return null
      word += c
      i++
    }
    words.push(word)
  }
  return words
}

const RM_FLAGS = new Set(['-r', '-R', '-rf', '-fr'])

/** `{ kind: 'git', dir, path }` or `{ kind: 'rm', path }` for an accepted form, else null. */
function acceptedForm(words) {
  if (!Array.isArray(words)) return null
  if (words[0] === 'git') {
    let i = 1
    let dir = null
    if (words[i] === '-C') {
      dir = words[i + 1]
      if (typeof dir !== 'string' || dir === '') return null
      i += 2
    }
    if (words[i] !== 'worktree' || words[i + 1] !== 'remove') return null
    i += 2
    const separated = words[i] === '--'
    if (separated) i++
    if (i !== words.length - 1) return null
    const target = words[i]
    if (target === '' || (!separated && target.startsWith('-'))) return null
    return { kind: 'git', dir, path: target }
  }
  if (words[0] === 'rm') {
    let i = 1
    if (RM_FLAGS.has(words[i])) i++
    if (i !== words.length - 1) return null
    const target = words[i]
    if (target === '' || target.startsWith('-')) return null
    return { kind: 'rm', path: target }
  }
  return null
}

/** `--force` and its abbreviations, `-f` alone or in a cluster. */
function isForceOption(word) {
  if (word.startsWith('--')) {
    const name = word.slice(2).split('=')[0]
    return name.length > 0 && 'force'.startsWith(name)
  }
  return /^-[^-]*f/.test(word)
}

/** A `worktree remove` that is not the accepted form: `{ force }`, else null. */
function worktreeRemoveShape(words) {
  for (let i = 0; i + 1 < words.length; i++) {
    if (words[i] === 'worktree' && words[i + 1] === 'remove') return { force: words.slice(i + 2).some(isForceOption) }
  }
  return null
}

const OUT_OF_SCOPE = new Set(['list', 'prune', 'move', 'lock', 'unlock', 'repair', 'add'])

/** `git [-C DIR] worktree list|prune|move|lock|unlock|repair|add ...`: no worktree is deleted, so not the guard's business. */
function outOfScopeWorktreeCommand(words) {
  if (words[0] !== 'git') return false
  const i = words[1] === '-C' ? 3 : 1
  return words[i] === 'worktree' && OUT_OF_SCOPE.has(words[i + 1])
}

// ---------------------------------------------------------------------------------------------------------- crude lexing

const CODE_LIKE = /[\s;&|()<>`$]/

// JP-157. Commands whose quoted text is data, not code: it is never run by them. Anything not listed (a shell, eval, sudo, env,
// xargs, find, ssh, tmux, an unknown program, a quote that starts a command) is an executor and its quoted text is read as code.
const DATA_INTERPRETER_RE = /^(?:python[\d.]*|node|nodejs|deno|bun|ruby|perl|php)$/
const CODE_FLAG_RE = /^(?:eval|--(?:eval|print|command|exec)|-[a-z]*[cepr][a-z]*)$/i
const DATA_GIT_COMMANDS = new Set(['commit', 'tag', 'log', 'show', 'notes', 'merge', 'stash', 'status', 'diff', 'branch', 'add', 'describe',
  'shortlog', 'blame', 'rev-parse', 'rev-list', 'ls-files', 'cherry-pick', 'revert', 'am', 'apply', 'checkout', 'switch', 'reset'])
const DATA_GH_COMMANDS = new Set(['api', 'pr', 'issue', 'run', 'repo', 'release', 'workflow', 'label', 'gist', 'search', 'project'])

/**
 * Whether quoted text is data for the command that owns it (`tokens` are its words so far; none yet means the quote starts the
 * command, which is code). A double-quoted `$(...)` or backtick runs even under echo, so it is always code. An interpreter is a
 * data owner only when no code flag (-c, -e, -p, -r, --eval) came before the quote.
 */
function quotedIsData(tokens, quote, text) {
  if (quote === '"' && /\$\(|`/.test(text)) return false
  let v = 0
  while (v < tokens.length && ASSIGNMENT_RE.test(tokens[v].text)) v++
  if (v >= tokens.length) return false
  const verb = path.basename(tokens[v].text).toLowerCase()
  const rest = tokens.slice(v + 1).map(t => t.text.toLowerCase())
  if (READ_ONLY_VERBS.has(verb) || verb === 'printf') return true
  if (DATA_INTERPRETER_RE.test(verb)) return !rest.some(w => CODE_FLAG_RE.test(w))
  if (verb === 'git' || verb === 'gh') {
    for (let k = 0; k < rest.length; k++) {
      if (rest[k].startsWith('-')) {
        if (verb === 'git' && GIT_VALUE_OPTIONS.has(rest[k])) k++
        continue
      }
      return (verb === 'git' ? DATA_GIT_COMMANDS : DATA_GH_COMMANDS).has(rest[k])
    }
  }
  return false
}

/**
 * The simple commands of any shell text, for the "appears to target" rule, never for execution. Each segment is
 * `{ tokens, end, sub, redirect }`: `end` is the operator that ended it (';', '\n', '&&', '||', '|', '&', '(', ')', '`' or ''),
 * `sub` marks a command whose output another command uses (inside $(...), <(...), >(...) or backticks), `redirect` an output
 * redirection. Quotes are stripped; a quoted part that looks like code for another interpreter (`bash -c '...'`, "$(...)") is
 * lexed again as well, and its segments follow. Each token's `mask` marks with `d` each character the shell could expand: `$`,
 * a glob, a bracket expression or brace list that is closed, a leading `~`, and `$` or a backtick inside double quotes.
 * Linear in the text's length (nested lexing at most twice).
 */
function lexSegments(text, depth = 0) {
  const segments = []
  const parens = []
  let backtick = false
  let seg = null
  let cur = ''
  let mask = ''
  let quote = null
  let quotedText = ''
  let nested = []
  let dataTexts = []
  const open = () => { seg = { tokens: [], end: '', sub: backtick || parens.includes(true), redirect: false } }
  const flush = () => {
    if (cur !== '') seg.tokens.push({ text: cur, mask: literalBrackets(cur, mask) })
    cur = ''
    mask = ''
  }
  const end = op => {
    flush()
    seg.end = op
    if (seg.tokens.length > 0) segments.push(seg)
    for (const s of nested) segments.push(s)
    nested = []
    // Data after a non-executing command is read as code only when its output goes somewhere that may run it (see quotedIsData).
    if (seg.sub || op === '|' || seg.redirect) for (const t of dataTexts) nested.push(...lexSegments(t, depth + 1))
    for (const s of nested) segments.push(s)
    nested = []
    dataTexts = []
  }
  // JP-157: quoted text is read as code only when the command it belongs to runs it; after echo, git commit and the like it is data.
  const relex = closing => {
    if (depth >= 2 || !CODE_LIKE.test(quotedText)) return
    if (quotedIsData(seg.tokens, closing, quotedText)) dataTexts.push(quotedText)
    else nested.push(...lexSegments(quotedText, depth + 1))
  }
  open()
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote !== null) {
      if (c === quote) {
        const closing = quote
        quote = null
        relex(closing)
        continue
      }
      let ch = c
      if (quote === '"' && c === '\\' && i + 1 < text.length) ch = text[++i]
      cur += ch
      quotedText += ch
      mask += quote === '"' && (ch === '$' || ch === '`') && c !== '\\' ? 'd' : '.'
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      quotedText = ''
      continue
    }
    if (c === '\\') {
      if (i + 1 < text.length && text[i + 1] !== '\n') {
        cur += text[i + 1]
        mask += '.'
      }
      i++
      continue
    }
    if (c === ';' || c === '\n' || c === '\r') {
      end(c === '\r' ? '\n' : c)
      open()
    } else if (c === '&') {
      if (text[i + 1] === '>') {
        i++
        flush()
        seg.redirect = true
        continue
      }
      const and = text[i + 1] === '&'
      if (and) i++
      end(and ? '&&' : '&')
      open()
    } else if (c === '|') {
      const or = text[i + 1] === '|'
      if (or || text[i + 1] === '&') i++
      end(or ? '||' : '|')
      open()
    } else if (c === '(') {
      // $( , <( and >( start a substitution whose output another command uses; a plain ( starts a subshell.
      const substitution = cur.endsWith('$') || text[i - 1] === '<' || text[i - 1] === '>'
      if (cur.endsWith('$')) {
        cur = cur.slice(0, -1)
        mask = mask.slice(0, -1)
      }
      end('(')
      parens.push(substitution)
      open()
    } else if (c === ')') {
      end(')')
      parens.pop()
      open()
    } else if (c === '`') {
      end('`')
      backtick = !backtick
      open()
    } else if (c === '>') {
      flush()
      seg.redirect = true
    } else if (/\s/.test(c) || c === '<' || c === '#' || c === '!') {
      flush()
    } else {
      cur += c
      mask += c === '$' || c === '*' || c === '?' || c === '[' || c === '{' || (c === '~' && cur.length === 1) ? 'd' : '.'
    }
  }
  if (quote !== null) relex(quote)
  end('')
  return segments
}

/** Every token of the text, in order (the word rules read these). */
function lexTokens(text) {
  return lexSegments(text).flatMap(s => s.tokens)
}

/**
 * A `[` is an expansion only with a closing `]` after at least one character, a `{` only with a comma or `..` before its `}`
 * (so `{}` in find and the `[` test command stay literal). One backward pass: linear.
 */
function literalBrackets(text, mask) {
  if (!mask.includes('d')) return mask
  const n = text.length
  const nextClose = new Array(n + 1).fill(-1)
  const nextBrace = new Array(n + 1).fill(-1)
  const nextList = new Array(n + 1).fill(-1)
  for (let i = n - 1; i >= 0; i--) {
    nextClose[i] = text[i] === ']' ? i : nextClose[i + 1]
    nextBrace[i] = text[i] === '}' ? i : nextBrace[i + 1]
    nextList[i] = text[i] === ',' || (text[i] === '.' && text[i + 1] === '.') ? i : nextList[i + 1]
  }
  let out = ''
  for (let i = 0; i < n; i++) {
    let m = mask[i]
    if (m === 'd' && text[i] === '[' && !(nextClose[i + 1] > i + 1)) m = '.'
    if (m === 'd' && text[i] === '{' && !(nextBrace[i + 1] >= 0 && nextList[i + 1] >= 0 && nextList[i + 1] < nextBrace[i + 1])) m = '.'
    out += m
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------- the guard process

function writeStderr(text) {
  const buffer = Buffer.from(text, 'utf8')
  let offset = 0
  for (let attempts = 0; offset < buffer.length && attempts < 10_000; attempts++) {
    try {
      offset += fs.writeSync(2, buffer, offset)
    } catch (error) {
      if (!error || error.code !== 'EAGAIN') return
    }
  }
}

/** The environment of both children: this process's, without INIT_CWD and npm's variables (the CLI trusts INIT_CWD under npm). */
function childEnv() {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (/^npm_/i.test(key) || key.toUpperCase() === 'INIT_CWD') continue
    env[key] = value
  }
  return env
}

function killGroup(child) {
  if (child.exited || !Number.isInteger(child.pid) || child.pid <= 1) return
  try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
}

/** Ends the process exactly once: kills every child group still running, prints, exits. Nothing after this runs. */
function finish(state, code, text) {
  if (state.done) return
  state.done = true
  try {
    for (const child of state.children) killGroup(child)
    if (text) writeStderr(text)
  } finally {
    process.exit(code)
  }
}

function block(state, code, detail, next, extra) {
  finish(state, 2, blockText(code, detail, next, extra))
}

function track(state, child) {
  const entry = { pid: child.pid, exited: false }
  state.children.push(entry)
  child.on('exit', () => { entry.exited = true })
}

/** Last line of defence: an exception anywhere ends in exit 2 unless the command is already known irrelevant. */
function lastResort(state) {
  if (state.relevance === 'irrelevant') return finish(state, 0, '')
  block(state, 'internal-error', 'the guard failed unexpectedly, so it cannot say this command is safe', NEXT_RETRY)
}

function onDeadline(state) {
  if (state.phase === 'check') {
    const t = shellWord(state.target)
    return block(state, 'timeout', `the removal check of ${quoted(state.target)} did not finish within 10 seconds`,
      `the guard's own check is bounded to 10 seconds. Stop every session that writes in ${t}; from the Atlas checkout (${shellWord(ATLAS_ROOT)}) run ` +
      `"npm run artifacts -- check-removal --worktree ${t} --timeout-ms 60000" until it exits 0, then ask the user to run "git worktree remove ${t}" without --force.`)
  }
  block(state, 'timeout', 'the guard did not finish within 10 seconds', NEXT_RETRY)
}

/**
 * Tests only: `atlas-removal-guard.js --checker-for-tests /abs/checker` (ruling R59). The hook command line comes from the settings,
 * which the installer writes without it, so an agent's environment or Bash `export` can never replace the checker.
 */
function checkerOverride(argv) {
  return argv.length === 2 && argv[0] === CHECKER_FLAG && typeof argv[1] === 'string' && argv[1] !== '' ? argv[1] : null
}

function main() {
  const state = { relevance: 'unknown', phase: 'input', target: null, done: false, children: [], checker: checkerOverride(process.argv.slice(2)) }
  process.on('uncaughtException', () => lastResort(state))
  process.on('unhandledRejection', () => lastResort(state))
  // process.uptime() counts from process start (node start-up included) and, unlike performance.now(), loads nothing.
  setTimeout(() => onDeadline(state), Math.max(0, DEADLINE_MS - process.uptime() * 1000))
  const chunks = []
  let size = 0
  let ended = false
  process.stdin.on('data', chunk => {
    if (ended) return
    size += chunk.length
    if (size > MAX_STDIN_BYTES) {
      ended = true
      block(state, 'unreadable-input', 'the hook input is larger than 4 MiB, so the command cannot be inspected', 'split the command into smaller commands.')
      return
    }
    chunks.push(chunk)
  })
  process.stdin.on('end', () => {
    if (ended) return
    ended = true
    onInput(state, Buffer.concat(chunks, size).toString('utf8'))
  })
  process.stdin.on('error', () => {
    if (ended) return
    ended = true
    block(state, 'unreadable-input', 'the hook input could not be read', NEXT_RETRY)
  })
}

function onInput(state, raw) {
  let input
  try { input = JSON.parse(raw) } catch { input = undefined }
  if (!isObject(input)) return block(state, 'unreadable-input', 'the hook input is not a JSON object', NEXT_RETRY)
  if (typeof input.tool_name === 'string' && input.tool_name !== 'Bash') {
    state.relevance = 'irrelevant'
    return finish(state, 0, '')
  }
  const command = isObject(input.tool_input) ? input.tool_input.command : undefined
  if (typeof command !== 'string') return block(state, 'unreadable-input', 'the Bash command could not be read from the hook input', NEXT_RETRY)
  if (!isRelevant(command)) {
    state.relevance = 'irrelevant'
    return finish(state, 0, '')
  }
  state.relevance = 'relevant'
  // A NUL cannot reach a shell, and a path cut at it is not the path the guard would judge: refuse rather than guess (M1).
  if (command.includes('\0')) return block(state, 'nul-in-command', 'the command contains a NUL character, which the guard cannot judge', 'remove the NUL character and run the command again.')
  // A bound that keeps the analysis linear and inside the deadline (M3).
  if (Buffer.byteLength(command, 'utf8') > MAX_COMMAND_BYTES) {
    return block(state, 'command-too-long', 'the command is longer than 64 KiB, too long for the guard to check', 'split it into smaller commands, with each deletion as its own simple command.')
  }
  startAnalysis(state, command, input.cwd)
}

function startAnalysis(state, command, cwd) {
  state.phase = 'analysis'
  const failed = () => block(state, 'internal-error', 'the command analysis failed, so the guard cannot say this command is safe', NEXT_RETRY)
  let child
  try {
    child = require('node:child_process').spawn(process.execPath, [__filename, ANALYZE_FLAG], {
      shell: false, detached: true, cwd: __dirname, stdio: ['pipe', 'pipe', 'ignore'], env: childEnv(),
    })
  } catch {
    return failed()
  }
  track(state, child)
  let text = ''
  let decided = false
  child.on('error', failed)
  // The decision is one JSON line; the analysis process may still be exiting (it is killed with its group if it lingers).
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    if (decided) return
    text += chunk
    const newline = text.indexOf('\n')
    if (newline >= 0) {
      decided = true
      onDecision(state, text.slice(0, newline))
    } else if (text.length > MAX_DECISION_CHARS) {
      decided = true
      failed()
    }
  })
  child.on('close', () => {
    if (decided) return
    decided = true
    failed()
  })
  child.stdin.on('error', () => { /* the analysis ended early: its missing decision decides */ })
  // The checker override travels explicitly, never through the environment.
  child.stdin.end(JSON.stringify({ command, cwd: cwd === undefined ? null : cwd, checker: state.checker }))
}

function validCheck(state, d) {
  const absolute = v => typeof v === 'string' && path.isAbsolute(v) && !v.includes('\0')
  return absolute(d.target) && !d.target.split('/').includes('..') && absolute(d.cwd)
    && (d.checker === DEFAULT_CHECKER || (state.checker !== null && absolute(d.checker) && d.checker === state.checker))
}

function onDecision(state, line) {
  let d
  try { d = JSON.parse(line) } catch { d = null }
  if (isObject(d) && d.action === 'allow') return finish(state, 0, '')
  if (isObject(d) && d.action === 'block' && typeof d.code === 'string' && /^[a-z-]{1,40}$/.test(d.code) && typeof d.detail === 'string' && typeof d.next === 'string') {
    return block(state, d.code, d.detail, d.next)
  }
  if (isObject(d) && d.action === 'check' && validCheck(state, d)) return startCheck(state, d)
  block(state, 'internal-error', 'the command analysis gave an unusable answer, so the guard cannot say this command is safe', NEXT_RETRY)
}

function startCheck(state, d) {
  state.phase = 'check'
  state.target = d.target
  const next = removalFlow(d.target)
  const unstarted = () => block(state, 'checker-failed', `the removal check of ${quoted(d.target)} could not be started`, next)
  const args = ['--disable-warning=ExperimentalWarning', d.checker, 'check-removal', '--worktree', d.target, '--json', '--timeout-ms', CHECKER_TIMEOUT_MS]
  let child
  try {
    child = require('node:child_process').spawn(process.execPath, args, {
      shell: false, cwd: d.cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv(),
    })
  } catch {
    return unstarted()
  }
  track(state, child)
  const out = []
  let size = 0
  child.on('error', unstarted)
  child.stdout.on('data', chunk => {
    size += chunk.length
    if (size > MAX_CHECKER_STDOUT_BYTES) return block(state, 'checker-failed', `the removal check of ${quoted(d.target)} printed more than 1 MiB`, next)
    out.push(chunk)
  })
  // Drained and never shown: it can hold paths and Git's own messages.
  child.stderr.resume()
  child.on('close', (code, signal) => {
    const verdict = checkerVerdict(code, signal, Buffer.concat(out).toString('utf8'), d.target)
    finish(state, verdict.exit, verdict.text)
  })
}

/** Exit 0 only for a checker exit 0 whose JSON is a complete, clean result for exactly this target (the CLI's own rule). */
function agrees(doc, result, target) {
  if (!result || doc.validFor !== 'next-removal-only') return false
  const c = result.coverage
  return result.exitCode === 0 && result.target === target && typeof result.checkedAt === 'string'
    && Array.isArray(result.risks) && result.risks.length === 0 && Array.isArray(result.unknowns) && result.unknowns.length === 0
    && isObject(c) && c.filesystem === 'complete' && c.git === 'complete' && c.catalog === 'complete' && c.sessions === 'inactive'
}

function issueLines(doc, result) {
  const issues = [...(Array.isArray(result.risks) ? result.risks : []), ...(Array.isArray(result.unknowns) ? result.unknowns : [])].filter(isObject)
  // The checker's paths and details are data: JSON-quoted and bounded, the code cut to a short token.
  const lines = issues.slice(0, MAX_ISSUES_SHOWN).map(i => `  - [${clip(String(i.code), 64)}] ${typeof i.path === 'string' ? `${quoted(i.path)}: ` : ''}${quoted(i.detail)}`)
  if (issues.length > MAX_ISSUES_SHOWN) lines.push(`  - ${issues.length - MAX_ISSUES_SHOWN} more: run the check yourself to see them all`)
  if (typeof doc.remoteRetentionNote === 'string') lines.push(`Remote retention: ${JSON.stringify(clip(doc.remoteRetentionNote, 2 * MAX_SHOWN_CHARS))}`)
  return lines
}

function checkerVerdict(code, signal, text, target) {
  let doc = null
  try { doc = JSON.parse(text) } catch { doc = null }
  const result = isObject(doc) && isObject(doc.result) ? doc.result : null
  if (signal === null && code === 0 && agrees(doc, result, target)) return { exit: 0, text: '' }
  const extra = result ? issueLines(doc, result) : []
  const next = removalFlow(target)
  let blocked
  if (signal !== null) {
    blocked = blockText('checker-failed', `the removal check of ${quoted(target)} was ended by ${signal}`, next)
  } else if (code === 3) {
    blocked = blockText('risks', `the removal check found risks in ${quoted(target)} (exit 3); removing it could lose work`,
      `resolve what is listed (preserve the files outside the worktree, commit them to a local branch, or stop the sessions in it), then ${next}`, extra)
  } else if (code === 2) {
    blocked = blockText('incomplete', `the removal check of ${quoted(target)} is incomplete (exit 2): coverage or proof is missing, so it cannot say the removal is safe`,
      `complete what is listed (for example, start the Atlas service so live sessions can be read), then ${next}`, extra)
  } else if (code === 0) {
    blocked = blockText('checker-failed', `the removal check of ${quoted(target)} exited 0, but its answer is missing or contradicts itself`, next, extra)
  } else {
    blocked = blockText('checker-failed', `the removal check of ${quoted(target)} failed (exit ${code})`, next)
  }
  return { exit: 2, text: blocked }
}

// ---------------------------------------------------------------------------------------------------------- the analysis process

const ALLOW = Object.freeze({ action: 'allow' })
const decline = (code, detail, next) => ({ action: 'block', code, detail, next })
const CWD_NEXT = 'cd to an existing directory and run the command again.'
const LIST_NEXT = `run "git worktree list" in the repository and use the absolute path it shows for the linked worktree. ${removalFlow(null)}`
const DELETION_VERBS = new Set(['rm', 'rmdir', 'unlink', 'shred', 'trash', 'trash-put', 'srm', 'rimraf'])
// Simple commands that only read (ruling R58). Their words do not count when nothing in the same simple command deletes and their
// output cannot become another command's target: no pipe after it, no output redirection, not inside a substitution.
const READ_ONLY_VERBS = new Set(['ls', 'cat', 'echo', 'pwd', 'stat', 'du', 'wc', 'head', 'tail', 'grep', 'rg'])
// Options whose value is a directory the command works in. Like a cd operand, the value is a base for later relative words and
// does not count as a target by itself (ruling R58).
const DIR_OPTION_RE = /^(-C|--chdir|--cwd|--directory|--work-tree|--git-dir)(=(.*))?$/
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/
// Git's own commands. An alias cannot shadow them, so `git remote remove` is never worktree removal; any other subcommand name can
// be an alias or an autocorrected `worktree` (ruling R60). `worktree` itself is deliberately absent.
const GIT_BUILTINS = new Set([
  'add', 'am', 'annotate', 'apply', 'archive', 'bisect', 'blame', 'branch', 'bundle', 'cat-file', 'check-attr', 'check-ignore', 'checkout',
  'cherry', 'cherry-pick', 'clean', 'clone', 'commit', 'commit-graph', 'config', 'count-objects', 'describe', 'diff', 'diff-files',
  'diff-index', 'diff-tree', 'difftool', 'fetch', 'for-each-ref', 'format-patch', 'fsck', 'gc', 'grep', 'hash-object', 'help', 'init',
  'log', 'ls-files', 'ls-remote', 'ls-tree', 'maintenance', 'merge', 'merge-base', 'mergetool', 'mv', 'notes', 'pack-refs', 'prune',
  'prune-packed', 'pull', 'push', 'range-diff', 'read-tree', 'rebase', 'reflog', 'remote', 'repack', 'replace', 'reset', 'restore',
  'rev-list', 'rev-parse', 'revert', 'rm', 'shortlog', 'show', 'show-branch', 'show-ref', 'sparse-checkout', 'stash', 'status',
  'submodule', 'switch', 'symbolic-ref', 'tag', 'update-index', 'update-ref', 'var', 'verify-commit', 'verify-tag', 'whatchanged',
  'write-tree',
])
// Git's global options that take the next word as their value (lowercased: -C and -c alike).
const GIT_VALUE_OPTIONS = new Set(['-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--exec-path'])
// A word is also read in pieces split at these, so a path glued to punctuation in a one-liner is still a path (C2).
const PIECE_CHARS = new Set([',', '(', ')', '{', '}', '[', ']', ':', '=', "'", '"'])
// The command's own directory and checkout top level, read like $PWD (I5). TOPLEVEL_VAR is a placeholder for the lexer only.
const TOPLEVEL_VAR = '$__ATLAS_GUARD_TOPLEVEL__'
const SUBSTITUTIONS = [
  [/\$\(\s*pwd(?:\s+-[LP])?\s*\)/g, '$PWD'],
  [/`\s*pwd(?:\s+-[LP])?\s*`/g, '$PWD'],
  [/\$\(\s*git\s+rev-parse\s+--show-toplevel\s*\)/g, TOPLEVEL_VAR],
  [/`\s*git\s+rev-parse\s+--show-toplevel\s*`/g, TOPLEVEL_VAR],
]
const LEAD_RE = /^(~|\$HOME|\$\{HOME\}|\$PWD|\$\{PWD\}|\$__ATLAS_GUARD_TOPLEVEL__)(?=\/|$)/
// For the text scan of C2: what continues a path name before it (then it is part of another path), and after it. A `~` before
// does not count: `q~/path~` in a one-liner is the path itself, and `~/path` reads as one too (erring toward blocking).
const BEFORE_PATH_RE = /[A-Za-z0-9._/-]/
const AFTER_PATH_RE = /[A-Za-z0-9._-]/

class GuardLimit extends Error {}
class CatalogUnreadable extends Error {}

function fsp() {
  return require('node:fs/promises')
}

/** Case-insensitive comparison: on a case-insensitive volume another spelling is the same folder, so it errs toward blocking. */
function fold(p) {
  return p.toLowerCase()
}

/** Whether `p` is `dir` or inside it, separator-aware. */
function isWithin(p, dir) {
  const fp = fold(p)
  const fd = fold(dir)
  return fp === fd || fp.startsWith(fd.endsWith('/') ? fd : `${fd}/`)
}

/** `rel` against `base` without normalizing `..`: the kernel resolves `..` after symbolic links, and canonical() does the same. */
function joinRaw(base, rel) {
  if (rel.startsWith('/')) return rel
  return base.endsWith('/') ? `${base}${rel}` : `${base}/${rel}`
}

/** The real path of an absolute path: its deepest existing ancestor resolved by the kernel, the missing rest added back. */
async function canonical(p) {
  const missing = []
  let head = p
  for (let i = 0; i < 4096; i++) {
    try {
      const real = await fsp().realpath(head)
      return missing.length === 0 ? real : path.resolve(real, ...missing.reverse())
    } catch (error) {
      const code = error && error.code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return path.resolve(p)
      const parent = path.dirname(head)
      if (parent === head) return path.resolve(p)
      missing.push(path.basename(head))
      head = parent
    }
  }
  return path.resolve(p)
}

async function isDirectory(p) {
  try { return (await fsp().stat(p)).isDirectory() } catch { return false }
}

/** The real path of an existing directory, else null. */
async function existingDirectory(p) {
  try {
    const real = await fsp().realpath(p)
    return (await isDirectory(real)) ? real : null
  } catch {
    return null
  }
}

async function deepestDirectory(p) {
  let head = p
  for (let i = 0; i < 4096; i++) {
    if (await isDirectory(head)) return head
    const parent = path.dirname(head)
    if (parent === head) return null
    head = parent
  }
  return null
}

/**
 * Directories directly in `dir` that are Git checkouts (have a `.git` entry). `limited` when the folder has more than
 * MAX_SCAN_ENTRIES entries or cannot be listed: then the scan proves nothing.
 */
async function childCheckouts(dir) {
  let entries
  try {
    entries = await fsp().readdir(dir, { withFileTypes: true })
  } catch (error) {
    return { found: [], limited: !(error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) }
  }
  if (entries.length > MAX_SCAN_ENTRIES) return { found: [], limited: true }
  const found = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const child = path.join(dir, entry.name)
    try {
      await fsp().lstat(path.join(child, '.git'))
      found.push(child)
    } catch { /* not a checkout */ }
  }
  return { found, limited: false }
}

/**
 * The Atlas catalog, read-only, opened on first use: never created, never migrated (no openDatabase), and only through
 * getArtifactRemovalContext, the checker's own SELECT-only reader. A missing catalog adds nothing; one that exists but cannot be
 * read stops every decision that needs it (CatalogUnreadable).
 */
function catalogReader() {
  let state = null
  const open = async () => {
    if (state !== null) return state
    try {
      const { loadConfig } = await import(require('node:url').pathToFileURL(CONFIG_MODULE).href)
      const dbPath = loadConfig(process.env).dbPath
      let stat
      try {
        stat = await fsp().lstat(dbPath)
      } catch (error) {
        state = { kind: error && (error.code === 'ENOENT' || error.code === 'ENOTDIR') ? 'missing' : 'error' }
        return state
      }
      if (!stat.isFile()) {
        state = { kind: 'error' }
        return state
      }
      const { getArtifactRemovalContext } = await import(require('node:url').pathToFileURL(CATALOG_MODULE).href)
      const { DatabaseSync } = require('node:sqlite')
      state = { kind: 'open', db: new DatabaseSync(dbPath, { readOnly: true }), getArtifactRemovalContext }
    } catch {
      state = { kind: 'error' }
    }
    return state
  }
  return {
    /** Registered checkout roots at or below `dir`; null when there is no catalog. */
    async checkoutsUnder(dir) {
      const s = await open()
      if (s.kind === 'missing') return null
      if (s.kind !== 'open') throw new CatalogUnreadable()
      try {
        const context = s.getArtifactRemovalContext({ raw: s.db }, dir)
        return context.roots.filter(r => r.kind === 'checkout' && typeof r.canonicalPath === 'string' && isWithin(r.canonicalPath, dir)).map(r => r.canonicalPath)
      } catch {
        throw new CatalogUnreadable()
      }
    },
    close() {
      if (state && state.kind === 'open') try { state.db.close() } catch { /* already closed */ }
    },
  }
}

/** Registered worktrees (main and linked) of the repositories looked at, from the Git adapter, and catalog checkout roots. */
function worktreeSet(git, catalog) {
  const list = []
  const add = found => { for (const w of found) if (!list.some(x => x.worktreePath === w.worktreePath)) list.push(w) }
  return {
    list,
    covers: p => list.some(w => isWithin(p, w.worktreePath)),
    async addRepositoryOf(dir) {
      add(await git.listGitWorktrees(dir))
    },
    /**
     * The repository of `dir`; with `scan`, also every checkout directly in it and the checkout roots the Atlas catalog registers
     * at or below it (I1). A folder too large to scan is covered only by a readable catalog; without one the guard cannot know.
     */
    async addAround(dir, scan) {
      add(await git.listGitWorktrees(dir))
      if (!scan) return
      const { found, limited } = await childCheckouts(dir)
      if (found.length > MAX_CHILD_CHECKOUTS) throw new GuardLimit(`${quoted(dir)} holds more than ${MAX_CHILD_CHECKOUTS} Git checkouts`)
      for (const child of found) if (!this.covers(child)) add(await git.listGitWorktrees(child))
      const registered = await catalog.checkoutsUnder(dir)
      if (registered === null && limited) {
        throw new GuardLimit(`${quoted(dir)} is too large to scan for checkouts and there is no Atlas catalog to consult`)
      }
      add((registered || []).map(root => ({ worktreePath: root, isMain: false, catalog: true })))
    },
  }
}

/** The home folder as given and as resolved (I1): neither it nor any folder containing it is ever deleted. */
async function homeEntries() {
  const given = require('node:os').homedir()
  if (typeof given !== 'string' || !path.isAbsolute(given)) return []
  const spellings = new Set([path.resolve(given)])
  try { spellings.add(await fsp().realpath(given)) } catch { /* as given */ }
  return [...spellings].map(p => ({ worktreePath: p, isMain: false, home: true }))
}

/** The checker: the test override the hook process passed explicitly, when it is an absolute path to a file; else Atlas's own. */
function checkerPath(requested) {
  if (typeof requested === 'string' && path.isAbsolute(requested)) {
    try { if (fs.statSync(requested).isFile()) return requested } catch { /* the default */ }
  }
  return DEFAULT_CHECKER
}

async function sessionDirectory(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) return null
  return existingDirectory(value)
}

/** Git's own reading of PATH (find_worktree): a unique suffix match at a directory boundary first, then the resolved path. */
function suffixMatches(full, suffix) {
  if (!suffix) return false
  const start = full.length - suffix.length
  if (start < 0 || (start > 0 && full[start - 1] !== '/')) return false
  return fold(full.slice(start)) === fold(suffix)
}

/** Ruling R56: the target only when the resolved path and every suffix match agree on exactly one worktree. */
async function removalTarget(text, base, worktrees) {
  const given = joinRaw(base, text)
  const spellings = [path.resolve(given), await canonical(given)]
  const exact = worktrees.filter(w => spellings.includes(w.worktreePath))
  const folded = worktrees.filter(w => spellings.some(s => fold(s) === fold(w.worktreePath)))
  const suffix = path.isAbsolute(text) ? [] : worktrees.filter(w => suffixMatches(w.worktreePath, text))
  if (exact.length > 1 || folded.length !== exact.length || suffix.length > 1 || (suffix.length === 1 && (exact.length !== 1 || suffix[0] !== exact[0]))) {
    return { kind: 'ambiguous', paths: [...new Set([...exact, ...folded, ...suffix])].map(w => w.worktreePath) }
  }
  return exact.length === 1 ? { kind: 'found', worktree: exact[0] } : { kind: 'none' }
}

async function gitRemoval(form, cwdGiven, cwd, git, requestedChecker) {
  const base = form.dir === null ? cwd : await existingDirectory(joinRaw(cwd, form.dir))
  if (base === null) return decline('not-a-worktree', `the -C directory ${quoted(form.dir)} does not exist`, LIST_NEXT)
  const worktrees = await git.listGitWorktrees(base)
  if (worktrees.length === 0) return decline('not-a-worktree', `${quoted(base)} is not inside a Git checkout, so there is no worktree to remove`, LIST_NEXT)
  const found = await removalTarget(form.path, base, worktrees)
  if (found.kind === 'ambiguous') {
    return decline('ambiguous-target', `${quoted(form.path)} could name ${names(found.paths)} (Git also matches a worktree by the end of its path)`,
      `use the absolute path of the worktree as "git worktree list" shows it. ${removalFlow(null)}`)
  }
  if (found.kind === 'none') return decline('not-a-worktree', `${quoted(form.path)} is not a linked worktree of the repository at ${quoted(base)}`, LIST_NEXT)
  if (found.worktree.isMain) return decline('main-worktree', `${quoted(found.worktree.worktreePath)} is the main checkout of its repository`, NEXT_MAIN)
  return { action: 'check', target: found.worktree.worktreePath, cwd: cwdGiven, checker: checkerPath(requestedChecker) }
}

async function directRm(form, cwd, git, catalog) {
  const given = joinRaw(cwd, form.path)
  const spellings = [path.resolve(given), await canonical(given)]
  if ((await homeEntries()).some(h => spellings.some(s => isWithin(h.worktreePath, s)))) {
    return decline('direct-rm', `${quoted(spellings[1])} is the home folder or contains it; rm would delete it without any check`, NEXT_HOME)
  }
  const known = worktreeSet(git, catalog)
  await known.addRepositoryOf(cwd)
  const hits = () => known.list.filter(w => spellings.some(s => isWithin(w.worktreePath, s)))
  if (hits().length === 0) {
    const anchor = await deepestDirectory(spellings[1])
    if (anchor !== null && !known.covers(anchor)) await known.addAround(anchor, anchor === spellings[1])
  }
  const found = hits()
  if (found.length === 0) return ALLOW
  const self = found.find(w => spellings.some(s => fold(s) === fold(w.worktreePath)))
  // An ancestor of a main checkout: there is no supported removal from a session, whatever else it holds.
  const hit = self || found.find(w => w.isMain) || found[0]
  const what = self ? `${quoted(hit.worktreePath)} is a ${kindOf(hit)}` : `${quoted(spellings[1])} contains the ${kindOf(hit)} ${quoted(hit.worktreePath)}`
  return decline('direct-rm', `${what}; rm would delete it without any check`, hit.isMain ? NEXT_MAIN : `do not delete worktrees with rm. ${flowFor(hit)}`)
}

/** A word and, when it holds punctuation, its pieces between PIECE_CHARS (C2). */
function piecesOf(token) {
  const out = [token]
  const t = token.text
  let start = 0
  let split = false
  for (let i = 0; i <= t.length; i++) {
    if (i < t.length && !PIECE_CHARS.has(t[i])) continue
    if (i < t.length) split = true
    if (split && i > start) out.push({ text: t.slice(start, i), mask: token.mask.slice(start, i) })
    start = i + 1
  }
  return out
}

/**
 * The paths one word can stand for, against every base it may be read from (`ctx.bases`, plus the uncertain rule when a directory
 * change could not be followed: `ctx.unknown`): literal spellings (lexical and real), or the prefixes a pattern leaves open (W + '/'
 * starting with one: W itself, an ancestor of W, or an entry directly in W). `~`, $HOME, $PWD, $(pwd) and the checkout top level
 * are expanded crudely; any other variable or command output cannot be known and gives null (the word rules still apply).
 */
async function candidate(piece, ctx) {
  let text = piece.text
  let mask = piece.mask
  const nul = text.indexOf('\0')
  if (nul >= 0) {
    text = text.slice(0, nul)
    mask = mask.slice(0, nul)
  }
  if (text === '' || text.startsWith('-')) return null
  let roots = null
  let rest = text
  let restMask = mask
  const lead = text.match(LEAD_RE)
  if (lead && mask[0] === 'd') {
    const name = lead[1]
    roots = name === '~' || name.includes('HOME') ? (ctx.home ? [ctx.home] : []) : name === TOPLEVEL_VAR ? ctx.toplevels() : ctx.bases
    if (roots.length === 0) return null
    rest = text.slice(name.length)
    restMask = mask.slice(name.length)
  } else if (mask[0] === 'd' && (text[0] === '$' || text[0] === '`')) {
    return null
  } else if (mask[0] === 'd' && text[0] === '~') {
    return { spellings: [], reals: [], prefixes: ['/'], anchors: [], relative: null }
  }
  const relative = roots === null && !text.startsWith('/')
  let absolutes
  if (roots !== null) absolutes = roots.map(r => [r + rest, '.'.repeat(r.length) + restMask])
  else if (relative) absolutes = ctx.bases.map(b => joinRaw(b, text)).map(a => [a, '.'.repeat(a.length - text.length) + mask])
  else absolutes = [[text, mask]]
  const c = { spellings: [], reals: [], prefixes: [], anchors: [], relative: null }
  const withSlash = d => (d.endsWith('/') ? d : `${d}/`)
  for (const [abs, m] of absolutes) {
    const dynAt = m.indexOf('d')
    if (dynAt < 0) {
      const real = await canonical(abs)
      c.spellings.push(path.resolve(abs), real)
      c.reals.push(real)
      if (await isDirectory(real)) c.anchors.push(real)
      continue
    }
    const prefix = abs.slice(0, dynAt)
    const slash = prefix.lastIndexOf('/')
    const dirGiven = prefix.slice(0, slash + 1) || '/'
    const real = await canonical(dirGiven)
    c.prefixes.push(withSlash(path.resolve(dirGiven)) + prefix.slice(slash + 1), withSlash(real) + prefix.slice(slash + 1))
    if (await isDirectory(real)) c.anchors.push(real)
  }
  if (relative && ctx.unknown) {
    const dynAt = mask.indexOf('d')
    if (dynAt < 0) c.relative = relativeShape(text, null)
    else if (dynAt > 0) {
      const prefix = text.slice(0, dynAt)
      const slash = prefix.lastIndexOf('/')
      c.relative = relativeShape(prefix.slice(0, slash + 1), prefix.slice(slash + 1))
    }
  }
  return c
}

/** A relative word after a directory change that could not be followed: compared with the components of every worktree path. */
function relativeShape(dirText, partial) {
  const segments = dirText.split('/').filter(s => s !== '')
  return { segments, partial, dots: segments.some(s => s === '.' || s === '..') || (partial === null && segments.length === 0) }
}

function relativeHit(shape, worktree) {
  if (shape.dots) return true
  const parts = worktree.worktreePath.split('/').filter(s => s !== '').map(fold)
  const want = shape.segments.map(fold)
  const last = shape.partial === null ? null : fold(shape.partial)
  for (let i = 0; i + want.length + (last === null ? 0 : 1) <= parts.length; i++) {
    if (!want.every((s, k) => parts[i + k] === s)) continue
    if (last === null || parts[i + want.length].startsWith(last)) return true
  }
  return false
}

function candidateHit(c, protectedPaths) {
  for (const w of protectedPaths) {
    if (c.spellings.some(s => isWithin(w.worktreePath, s))) return w
    if (c.prefixes.some(p => fold(`${w.worktreePath}/`).startsWith(fold(p)))) return w
    if (c.relative && relativeHit(c.relative, w)) return w
  }
  return null
}

/** C2 backstop: a known worktree path written inside a word, ending there or at a character no path name continues with. */
function textHit(tokens, worktrees) {
  for (const w of worktrees) {
    const needle = fold(w.worktreePath)
    if (needle.length < 2) continue
    for (const t of tokens) {
      const hay = fold(t.text)
      for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) {
        if (at > 0 && BEFORE_PATH_RE.test(hay[at - 1])) continue
        const end = at + needle.length
        if (end === hay.length || !(hay[end] === '/' || AFTER_PATH_RE.test(hay[end]))) return w
        if (hay[end] === '/' && (end + 1 === hay.length || !(hay[end + 1] === '/' || AFTER_PATH_RE.test(hay[end + 1])))) return w
      }
    }
  }
  return null
}

function deletesSomething(lower) {
  for (const word of lower) {
    if (DELETION_VERBS.has(path.basename(word))) return true
    if (word.includes('rmtree') || word.includes('rimraf') || /^-+delete/.test(word) || word.startsWith('-exec')) return true
  }
  return lower.has('git') && lower.has('clean')
}

/** Ruling R60: a git command in these words whose subcommand is `worktree` or could be an alias of it. */
function gitMayBeWorktree(words) {
  for (let i = 0; i < words.length; i++) {
    if (path.basename(words[i]) !== 'git') continue
    for (let k = i + 1; k < words.length; k++) {
      const w = words[k]
      if (w.startsWith('-')) {
        if (GIT_VALUE_OPTIONS.has(w)) k++
        continue
      }
      if (w === 'worktree' || !GIT_BUILTINS.has(w)) return true
      break
    }
  }
  return false
}

// JP-157: words that may delete, move or prune something, in a command or in code text (os.remove, shutil.rmtree, fs.rmSync). Matching more
// than needed is safe: it only opens the gate to the path rules below, which are unchanged.
const DELETING_WORD_RE = /(?:^|[./])(?:rm|rmdir|unlink|shred|trash|trash-put|srm|rimraf|rmtree|rmsync|remove|removesync|prune|rename|move|mv)$|rmtree|rimraf|^-+delete|^-exec/i
const DELETING_CODE_RE = /rm_r|rm_f|rmdir|rmtree|rimraf|rmsync|unlink|remove|delete|shred|trash|rename|move/i
const RUNS_ARBITRARY_RE = /^(?:eval|exec|source|\.|sh|bash|zsh|dash|ksh|csh|fish)$/

/** The deletion gate (JP-157): the first word of a segment that may delete or move something, a computed command name included, or null. */
function deletingWord(seg, skipped) {
  if (skipped) return null
  let v = 0
  while (v < seg.tokens.length && ASSIGNMENT_RE.test(seg.tokens[v].text)) v++
  // A computed command name (`$x`, `${c}m`, `$'\x72m'`), as the command or right after a wrapper such as sudo, may be anything.
  for (const t of seg.tokens.slice(v, v + 2)) {
    if ((t.mask.includes('d') && !t.text.includes('/')) || RUNS_ARBITRARY_RE.test(t.text.toLowerCase())) return t.text
  }
  const words = new Set(seg.tokens.map(t => t.text.toLowerCase()))
  if (words.has('git') && words.has('clean')) return 'git clean'
  // Code text (an interpreter one-liner) glues the call to its object: FileUtils.rm_rf, File.delete, Deno.removeSync. A token with no
  // blank and no slash (so not a path and not prose) opens the gate on the name anywhere inside it.
  for (const t of seg.tokens) if (DELETING_WORD_RE.test(t.text) || (!/[\s/]/.test(t.text) && DELETING_CODE_RE.test(t.text))) return t.text
  return null
}

/** Ruling R58: a read-only simple command whose output goes nowhere and that deletes nothing; its words do not count. */
function readOnlySkip(seg) {
  let v = 0
  while (v < seg.tokens.length && ASSIGNMENT_RE.test(seg.tokens[v].text)) v++
  const verb = v < seg.tokens.length ? path.basename(seg.tokens[v].text).toLowerCase() : ''
  return READ_ONLY_VERBS.has(verb) && !seg.sub && seg.end !== '|' && !seg.redirect && !deletesSomething(new Set(seg.tokens.map(t => t.text.toLowerCase())))
}

/**
 * Rulings R57, R58 and R60 for a command outside the accepted grammar: blocked only when its text appears to target a managed
 * worktree or the home folder. The simple commands are walked in order. A cd/pushd operand and the value of -C, --work-tree and
 * the like are not targets by themselves; a literal one is added to the bases later relative words are resolved against (the
 * earlier bases stay, since the change may fail), anything computed makes later relative words uncertain. The words of a
 * read-only simple command whose output goes nowhere do not count. Every other word keeps the full rule.
 */
async function appearsToTarget(command, words, cwd, git, catalog) {
  let text = command
  for (const [re, to] of SUBSTITUTIONS) text = text.replace(re, () => to)
  const segments = lexSegments(text)
  if (segments.reduce((n, s) => n + s.tokens.length, 0) > MAX_TOKENS) return decline('manual-resolution', 'the command is too long for the guard to check', manualNext(null))
  // JP-157: a command that deletes, moves or prunes nothing is not this guard's business. The path, anchor and checkout-count rules
  // below (and their Git and filesystem work) run only for a command with a deleting word.
  const gateWord = segments.map(seg => deletingWord(seg, readOnlySkip(seg))).find(w => w !== null)
  if (gateWord === undefined) return ALLOW
  const known = worktreeSet(git, catalog)
  await known.addRepositoryOf(cwd)
  const homes = await homeEntries()
  const ctx = {
    bases: [cwd], unknown: false, home: homes.length > 0 ? homes[0].worktreePath : null,
    // The checkout top level of each base: the innermost known worktree that contains it.
    toplevels: () => ctx.bases.map(b => known.list.filter(w => isWithin(b, w.worktreePath)).sort((x, y) => y.worktreePath.length - x.worktreePath.length)[0])
      .filter(Boolean).map(w => w.worktreePath),
  }
  const changeDirectory = async token => {
    const c = await candidate(token, ctx)
    if (c === null || c.prefixes.length > 0 || c.reals.length === 0) ctx.unknown = true
    else for (const real of c.reals) if (!ctx.bases.includes(real)) ctx.bases.push(real)
  }
  const considered = []
  const consideredBySegment = []
  const snippets = []
  const candidates = []
  for (const seg of segments) {
    const toks = seg.tokens
    let v = 0
    while (v < toks.length && ASSIGNMENT_RE.test(toks[v].text)) v++
    const verb = v < toks.length ? path.basename(toks[v].text).toLowerCase() : ''
    const skip = readOnlySkip(seg)
    const shown = deletingWord(seg, skip) || verb
    const operands = new Set()
    if (verb === 'cd' || verb === 'pushd') {
      let k = v + 1
      while (k < toks.length && toks[k].text.startsWith('-') && toks[k].text !== '-') k++
      if (k < toks.length) operands.add(k)
      else if (seg.end === '(' || seg.end === '`') ctx.unknown = true
      else if (ctx.home) ctx.bases.push(ctx.home)
    } else if (verb === 'popd') {
      ctx.unknown = true
    }
    const mine = []
    for (let k = 0; k < toks.length; k++) {
      const t = toks[k]
      const option = t.text.match(DIR_OPTION_RE)
      if (option) {
        if (option[3] !== undefined) await changeDirectory({ text: option[3], mask: t.mask.slice(t.mask.length - option[3].length) })
        else operands.add(k + 1)
        continue
      }
      if (t.text === '-execdir') ctx.unknown = true
      if (operands.has(k)) {
        await changeDirectory(t)
        continue
      }
      if (skip) continue
      considered.push(t)
      mine.push(t.text.toLowerCase())
      for (const piece of piecesOf(t)) {
        const c = await candidate(piece, ctx)
        if (c) candidates.push(Object.assign(c, { verb: shown, word: t.text }))
      }
    }
    consideredBySegment.push(mine)
    snippets.push(clip(toks.map(t => t.text).join(' '), 120))
  }
  const lower = new Set(considered.map(t => t.text.toLowerCase()))
  if ((lower.has('remove') || lower.has('prune')) && (lower.has('worktree') || consideredBySegment.some(gitMayBeWorktree))) {
    const at = consideredBySegment.findIndex(w => w.includes('remove') || w.includes('prune'))
    return decline('manual-resolution', `${quoted(snippets[at] || '')} removes or prunes Git worktrees (or runs a git command that may be an alias of worktree) in a form the guard cannot check`, manualNext(null))
  }
  if (deletesSomething(lower) && considered.some(t => /worktree/i.test(t.text))) {
    return decline('manual-resolution', `${quoted(gateWord)} deletes something and ${quoted(considered.find(t => /worktree/i.test(t.text)).text)} mentions a worktree, in a form the guard cannot check`, manualNext(null))
  }
  let by = null
  const firstHit = () => {
    const protectedPaths = [...known.list, ...homes]
    for (const c of candidates) {
      const hit = candidateHit(c, protectedPaths)
      if (hit) { by = c; return hit }
    }
    return null
  }
  let hit = firstHit()
  if (!hit) {
    const anchors = [...new Set(candidates.flatMap(c => c.anchors))].filter(a => !known.covers(a))
    if (anchors.length > MAX_ANCHORS) throw new GuardLimit('the command names more folders than the guard can check')
    for (const anchor of anchors) if (!known.covers(anchor)) await known.addAround(anchor, true)
    hit = firstHit() || textHit(considered, known.list)
  }
  if (!hit) return ALLOW
  // A plain deletion command (rm -f, rmdir, /bin/rm, two targets) reads as a direct rm; anything else needs manual resolution.
  if (words !== null && DELETION_VERBS.has(path.basename(words[0] || '').toLowerCase())) {
    return decline('direct-rm', `it would delete the ${kindOf(hit)} ${quoted(hit.worktreePath)} (or a folder containing it) without any check`,
      hit.isMain ? NEXT_MAIN : `do not delete worktrees with rm. ${flowFor(hit)}`)
  }
  const via = by ? `${quoted(by.verb)} (word ${quoted(by.word)})` : quoted(gateWord)
  return decline('manual-resolution', `${via} appears to target the ${kindOf(hit)} ${quoted(hit.worktreePath)} in a form the guard cannot check`, manualNext(hit))
}

async function analyze(command, cwdGiven, requestedChecker) {
  const words = tokenize(command)
  const form = acceptedForm(words)
  if (words !== null && form === null) {
    const shape = worktreeRemoveShape(words)
    if (shape && shape.force) {
      return decline('force', 'git worktree remove --force (or -f) skips Git\'s own dirty-worktree checks and is never used in automated cleanup', removalFlow(null))
    }
    if (shape) {
      return decline('unsupported-form', 'this form of git worktree remove cannot be checked; the accepted form is: git [-C <dir>] worktree remove [--] <path>', removalFlow(null))
    }
    if (outOfScopeWorktreeCommand(words)) return ALLOW
  }
  const cwd = await sessionDirectory(cwdGiven)
  if (cwd === null) return decline('cwd-unavailable', 'the session\'s working directory is missing or is not an existing directory', CWD_NEXT)
  const git = await import(require('node:url').pathToFileURL(GIT_ADAPTER).href)
  const catalog = catalogReader()
  try {
    if (form && form.kind === 'git') return await gitRemoval(form, cwdGiven, cwd, git, requestedChecker)
    if (form && form.kind === 'rm') return await directRm(form, cwd, git, catalog)
    return await appearsToTarget(command, words, cwd, git, catalog)
  } catch (error) {
    if (error instanceof GuardLimit) return decline('worktrees-unknown', error.message, manualNext(null))
    if (error instanceof CatalogUnreadable) {
      return decline('worktrees-unknown', 'the Atlas catalog exists but cannot be read, so the guard cannot tell which checkouts this command would delete',
        'make the Atlas catalog readable (or run the Atlas service so it repairs it), or ask the user to run the command.')
    }
    if (error && error.name === 'GitAdapterError') {
      return decline('worktrees-unknown', `Git could not list the worktrees (${clip(String(error.code), 64)}), so the guard cannot tell what this command would delete`,
        'make "git worktree list" work in this repository, or ask the user to run the command.')
    }
    throw error
  } finally {
    catalog.close()
  }
}

function readStream(stream, cap) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    stream.on('data', chunk => {
      size += chunk.length
      if (size > cap) reject(new Error('input too large'))
      else chunks.push(chunk)
    })
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    stream.on('error', reject)
  })
}

/** The analysis child: one request on stdin, one decision line on stdout. Any failure exits nonzero with no decision. */
async function analyzeMain() {
  process.on('uncaughtException', () => process.exit(70))
  process.on('unhandledRejection', () => process.exit(70))
  const request = JSON.parse(await readStream(process.stdin, 2 * MAX_STDIN_BYTES))
  if (!isObject(request) || typeof request.command !== 'string') process.exit(70)
  const decision = await analyze(request.command, request.cwd, request.checker)
  process.stdout.write(`${JSON.stringify(decision)}\n`, () => process.exit(0))
}

module.exports = { tokenize, acceptedForm, isRelevant, sanitize, lexSegments, lexTokens, LIMITS }
if (require.main === module) {
  if (process.argv[2] === ANALYZE_FLAG) analyzeMain()
  else main()
}
