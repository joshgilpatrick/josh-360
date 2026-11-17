import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { classifyRecord, type TranscriptRecord } from './records.ts'

export type Checkpoint = {
  sessionId: string; transcriptPath: string; byteOffset: number; lastRecordUuid: string | null
  compactionGeneration: number; compactionBaselineUuid: string | null; usageFingerprint: string | null
}
export type TranscriptDelta = { records: TranscriptRecord[]; nextOffset: number; truncated: boolean; compactionSeen: boolean; lastUuid: string | null; bytesRead: number }
export type TranscriptScan = { records: TranscriptRecord[]; bytesRead: number; linesRead: number; malformedLines: number; trailingPartial: boolean; truncated: boolean }
export type TranscriptChunk = {
  records: TranscriptRecord[]; bytesRead: number; nextOffset: number; linesRead: number
  malformedLines: number; reachedEnd: boolean; stalled: boolean; sourceSize: number
}

export function newCheckpoint(sessionId: string, transcriptPath: string): Checkpoint {
  return { sessionId, transcriptPath, byteOffset: 0, lastRecordUuid: null, compactionGeneration: 0, compactionBaselineUuid: null, usageFingerprint: null }
}

export function scanTranscriptFromStart(transcriptPath: string, endOffset: number, maxBytes: number): TranscriptScan {
  const empty = (): TranscriptScan => ({ records: [], bytesRead: 0, linesRead: 0, malformedLines: 0, trailingPartial: false, truncated: false })
  if (!Number.isSafeInteger(endOffset) || endOffset < 0 || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) return empty()
  const fd = openSync(transcriptPath, 'r')
  try {
    const size = fstatSync(fd).size
    // A checkpoint ahead of EOF is unsafe for replay: do not guess at a repair boundary.
    if (size < endOffset) return empty()
    const want = Math.min(endOffset, maxBytes)
    if (want === 0) return empty()
    const buf = Buffer.alloc(want)
    const got = readSync(fd, buf, 0, want, 0)
    const records: TranscriptRecord[] = []
    let linesRead = 0
    let malformedLines = 0
    let start = 0
    let lastNl = -1
    while (true) {
      const nl = buf.indexOf(0x0a, start)
      if (nl < 0) break
      const line = buf.subarray(start, nl).toString('utf8').replace(/\r$/, '')
      linesRead += 1
      if (line.trim()) {
        try {
          for (const record of classifyRecord(JSON.parse(line))) if (record.kind !== 'other') records.push(record)
        } catch {
          malformedLines += 1
        }
      }
      lastNl = nl
      start = nl + 1
    }
    return {
      records,
      bytesRead: lastNl + 1,
      linesRead,
      malformedLines,
      trailingPartial: start < got,
      truncated: maxBytes < endOffset,
    }
  } finally {
    closeSync(fd)
  }
}

// Bounded-memory replacement for a whole-span scan (spec §5.1, invariant 6): read one window of
// at most `maxBytes` starting at `startOffset`, stop on the last complete line inside it, and let
// the caller loop until `reachedEnd`. Peak memory is the window, never the file. `endOffset` is a
// checkpoint boundary, which the live reader always parks just after a newline, so the final
// window ends cleanly without a trailing-partial case.
export function scanTranscriptChunk(transcriptPath: string, startOffset: number, endOffset: number, maxBytes: number): TranscriptChunk {
  const stop = (sourceSize: number, reachedEnd: boolean, stalled: boolean): TranscriptChunk =>
    ({ records: [], bytesRead: 0, nextOffset: startOffset, linesRead: 0, malformedLines: 0, reachedEnd, stalled, sourceSize })
  if (!Number.isSafeInteger(startOffset) || startOffset < 0) return stop(0, false, true)
  if (!Number.isSafeInteger(endOffset) || endOffset < startOffset) return stop(0, false, true)
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) return stop(0, false, true)
  const fd = openSync(transcriptPath, 'r')
  try {
    const size = fstatSync(fd).size
    // A boundary past EOF is unsafe: the source shrank or the checkpoint is ahead. Never guess.
    if (size < endOffset) return stop(size, false, true)
    if (startOffset === endOffset) return stop(size, true, false)
    const want = Math.min(maxBytes, endOffset - startOffset)
    const buf = Buffer.alloc(want)
    const got = readSync(fd, buf, 0, want, startOffset)
    const lastNl = buf.lastIndexOf(0x0a, got - 1)
    if (lastNl < 0) return stop(size, false, true)
    const records: TranscriptRecord[] = []
    let linesRead = 0
    let malformedLines = 0
    let start = 0
    while (start <= lastNl) {
      const nl = buf.indexOf(0x0a, start)
      if (nl < 0 || nl > lastNl) break
      const line = buf.subarray(start, nl).toString('utf8').replace(/\r$/, '')
      linesRead += 1
      if (line.trim()) {
        try {
          for (const record of classifyRecord(JSON.parse(line))) if (record.kind !== 'other') records.push(record)
        } catch {
          malformedLines += 1
        }
      }
      start = nl + 1
    }
    const bytesRead = lastNl + 1
    const nextOffset = startOffset + bytesRead
    return { records, bytesRead, nextOffset, linesRead, malformedLines, reachedEnd: nextOffset === endOffset, stalled: false, sourceSize: size }
  } finally {
    closeSync(fd)
  }
}

// Finds the end of the line that starts at `offset`, reading forward in 1 MiB steps but never past `limit` bytes.
// Returns the line's length including its newline, or -1 when no newline appears within `limit` (or before EOF).
function lineLengthAt(fd: number, offset: number, size: number, limit: number): number {
  const step = Buffer.alloc(Math.min(1 << 20, limit))
  let scanned = 0
  while (scanned < limit && offset + scanned < size) {
    const want = Math.min(step.length, limit - scanned, size - offset - scanned)
    const got = readSync(fd, step, 0, want, offset + scanned)
    if (got <= 0) return -1
    const nl = step.indexOf(0x0a, 0)
    if (nl >= 0 && nl < got) return scanned + nl + 1
    scanned += got
  }
  return -1
}

export type ReadDeltaOptions = {
  /** When the first line after the checkpoint is longer than `maxBytes`, read that one line whole if it is at most this
   * many bytes, instead of stalling on it. Unset keeps the old behaviour: an oversized line stalls the read. */
  maxLineBytes?: number
}

export function readDelta(transcriptPath: string, checkpoint: Checkpoint, maxBytes: number, opts: ReadDeltaOptions = {}): TranscriptDelta {
  const empty = (nextOffset: number): TranscriptDelta => ({ records: [], nextOffset, truncated: false, compactionSeen: false, lastUuid: checkpoint.lastRecordUuid, bytesRead: 0 })
  const fd = openSync(transcriptPath, 'r')
  try {
    const size = fstatSync(fd).size
    if (size < checkpoint.byteOffset) return empty(0)
    if (size === checkpoint.byteOffset) return empty(size)
    const want = Math.min(maxBytes, size - checkpoint.byteOffset)
    let buf = Buffer.alloc(want)
    const got = readSync(fd, buf, 0, want, checkpoint.byteOffset)
    let lastNl = buf.lastIndexOf(0x0a, got - 1)
    if (lastNl < 0) {
      // The window holds no complete line. If it is full and an oversized-line allowance is set, read that one line whole.
      const ceiling = opts.maxLineBytes ?? 0
      const lineLen = got === maxBytes && ceiling > maxBytes ? lineLengthAt(fd, checkpoint.byteOffset, size, ceiling) : -1
      if (lineLen < 0) {
        // A full window with no newline is a stall, unless the line simply has not been finished yet (it runs to EOF).
        const stalled = got === maxBytes && (ceiling <= maxBytes || size - checkpoint.byteOffset > ceiling)
        return { ...empty(checkpoint.byteOffset), truncated: stalled }
      }
      buf = Buffer.alloc(lineLen)
      readSync(fd, buf, 0, lineLen, checkpoint.byteOffset)
      lastNl = lineLen - 1
    }
    const chunk = buf.subarray(0, lastNl + 1).toString('utf8')
    const records: TranscriptRecord[] = []
    let lastUuid = checkpoint.lastRecordUuid
    let compactionSeen = false
    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue
      let raw: unknown
      try { raw = JSON.parse(line) } catch { continue }
      if (raw && typeof raw === 'object' && typeof (raw as { uuid?: unknown }).uuid === 'string') lastUuid = (raw as { uuid: string }).uuid
      for (const r of classifyRecord(raw)) {
        if (r.kind === 'compact_boundary') compactionSeen = true
        if (r.kind !== 'other') records.push(r)
      }
    }
    const nextOffset = checkpoint.byteOffset + lastNl + 1
    return { records, nextOffset, truncated: nextOffset < size, compactionSeen, lastUuid, bytesRead: lastNl + 1 }
  } finally {
    closeSync(fd)
  }
}
