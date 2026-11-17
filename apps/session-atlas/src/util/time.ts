export function nowIso(): string {
  return new Date().toISOString()
}

export function isoFromEpochMs(ms: number): string {
  return new Date(ms).toISOString()
}
