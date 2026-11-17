export type Tool = 'claude-code' | 'opencode' | 'pi'

export type PricingStatus = 'priced' | 'missing_price' | 'missing_alias' | 'suspect' | 'no_usage'

export type AttributionQuality = 'exact' | 'derived' | 'unknown'

/** One model call as a parser saw it, before attribution and dedup. Token fields: null = absent (never 0). */
export type ParsedMessage = {
  tool: Tool
  sourceMessageId: string
  sourceSessionId: string | null
  sourceAgentId?: string | null
  /** ISO-8601 UTC with milliseconds, produced by new Date(x).toISOString(). */
  tsUtc: string
  modelRaw: string
  providerRaw: string | null
  /** Uncached input tokens only. */
  inputTokens: number | null
  /** Billed output tokens (OpenCode: output + reasoning). */
  outputTokens: number | null
  /** Informational only; already included in outputTokens. */
  reasoningTokens: number | null
  cacheReadTokens: number | null
  cacheWrite5mTokens: number | null
  cacheWrite1hTokens: number | null
  /** Cache-write tokens the source did not split by lifetime; priced at the 5m rate. */
  cacheWriteUnclassifiedTokens: number | null
  /** Cost the source itself logged (OpenCode, Pi); cross-check only. */
  loggedCostUsd: number | null
  isSidechain: boolean
  cwd: string | null
  /** Exact branch from the source, or null when unknown. */
  gitBranch: string | null
  sourcePath: string
  /** Stable position inside sourcePath, for example "line:42" or "row:msg_abc". */
  sourceLocator: string
  usageStatus: 'ok' | 'no_usage'
}

/** Result of resolving a cwd to a repository. */
export type Attribution = {
  repoKey: string | null
  displayName: string | null
  rootPath: string | null
  worktreePath: string | null
  /** live = git answered; fallback = directory gone, path pattern used; none = no repo. */
  resolution: 'live' | 'fallback' | 'none'
}
