import { homedir } from 'node:os'
import { join } from 'node:path'

// JP-111: the cost import lives in cache.db beside the artifact catalog (rebuildable working tables), not in its own file.
export const DEFAULT_LEDGER_PATH = join(process.env.JOSH360_HOME ?? join(homedir(), '.josh-360'), 'state', 'cache.db')

/** First OpenCode assistant row with a logged cost above 0 (2026-09-28T16:55:16.107Z). Earlier rows are skipped. */
export const OPENCODE_COST_CUTOFF_MS = 1790614516107

/** Prompt-side tokens above this make a message suspect (largest legitimate row seen: 483k). */
export const SUSPECT_PROMPT_TOKENS = 2_000_000
/** Output tokens above this make a message suspect. */
export const SUSPECT_OUTPUT_TOKENS = 500_000
