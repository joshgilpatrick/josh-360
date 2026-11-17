// Measurement probe for test/perf/artifact-manager.test.ts. It is preloaded with `node --import` into a REAL Atlas service
// child process (src/service/main.ts, unmodified) and only observes: an event-loop delay histogram (perf_hooks
// monitorEventLoopDelay), the process's own CPU time and RSS. It answers snapshot requests over the IPC channel the test
// opens; without an IPC channel it does nothing. It never touches the service's modules, database, sockets or files.

import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks'

type SnapshotRequest = { type: 'perf-snapshot'; id: number; reset?: boolean; gc?: boolean }

if (typeof process.send === 'function') {
  const resolution = Math.max(1, Number(process.env.ATLAS_PERF_PROBE_RESOLUTION_MS ?? '10') || 10)
  let histogram: IntervalHistogram = monitorEventLoopDelay({ resolution })
  histogram.enable()
  let windowStart = performance.now()
  let cpuStart = process.cpuUsage()
  let peakRss = process.memoryUsage.rss()
  const sampler = setInterval(() => {
    const rss = process.memoryUsage.rss()
    if (rss > peakRss) peakRss = rss
  }, 50)
  sampler.unref()

  const ms = (ns: number): number => Math.round((ns / 1e6) * 100) / 100
  // `gc: true` runs a full collection first, but only when the process was started with --expose-gc (a diagnostic flag the
  // PERF-12 test sets on its own service); `gcRan` says whether it did, so a missing flag is a failure and not a silent zero.
  const snapshot = (gc: boolean) => {
    const gcRan = gc && typeof globalThis.gc === 'function'
    if (gcRan) { globalThis.gc!(); globalThis.gc!() }
    const cpu = process.cpuUsage(cpuStart)
    const count = histogram.count
    return {
      windowMs: Math.round(performance.now() - windowStart),
      samples: count,
      p50Ms: count > 0 ? ms(histogram.percentile(50)) : 0,
      p95Ms: count > 0 ? ms(histogram.percentile(95)) : 0,
      p99Ms: count > 0 ? ms(histogram.percentile(99)) : 0,
      maxMs: count > 0 ? ms(histogram.max) : 0,
      meanMs: count > 0 ? ms(histogram.mean) : 0,
      cpuUserMs: Math.round(cpu.user / 1000),
      cpuSystemMs: Math.round(cpu.system / 1000),
      rssBytes: process.memoryUsage.rss(),
      peakRssBytes: peakRss,
      // Live bytes outside the V8 heap (Buffers and ArrayBuffers). After a collection this is what the process still holds;
      // memory the allocator keeps after a free shows in RSS but not here.
      arrayBuffersBytes: process.memoryUsage().arrayBuffers,
      externalBytes: process.memoryUsage().external,
      gcRan,
    }
  }
  const reset = () => {
    histogram.disable()
    histogram = monitorEventLoopDelay({ resolution })
    histogram.enable()
    windowStart = performance.now()
    cpuStart = process.cpuUsage()
    peakRss = process.memoryUsage.rss()
  }
  process.on('message', (raw: unknown) => {
    const m = raw as SnapshotRequest | null
    if (!m || m.type !== 'perf-snapshot' || typeof m.id !== 'number') return
    const stats = snapshot(m.gc === true)
    if (m.reset) reset()
    process.send?.({ type: 'perf-snapshot', id: m.id, stats })
  })
  // The channel must not keep the service alive on its own (the service decides when it exits).
  process.channel?.unref()
}
