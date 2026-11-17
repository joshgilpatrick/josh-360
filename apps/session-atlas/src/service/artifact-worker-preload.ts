// Preloaded (node --import) into the artifact worker process by src/service/artifact-worker.ts. The Git adapter starts every
// Git child detached, in a process group of its own, so killing the worker does not kill its Git children (spec s10: no live
// process may survive a restart). This module reports each child the worker starts to the service over the extra pipe the
// service opened as fd 3 -- `S <pid>` when it starts, `E <pid>` when it exits -- so the service can kill those groups when the
// worker crashes, hangs, is restarted or the service stops.
//
// It reports only when the service says fd 3 is its pipe (ATLAS_ARTIFACT_WORKER_PID_FD=3) and fd 3 is a socket or FIFO, so a
// worker started any other way never writes into an unrelated descriptor. Pids only: no paths, names or arguments. It imports
// nothing beyond Node built-ins, so the worker's module graph stays free of the database.

import diagnosticsChannel from 'node:diagnostics_channel'
import type { ChildProcess } from 'node:child_process'
import { fstatSync, writeSync } from 'node:fs'

const FD = 3

function reporting(): boolean {
  if (process.env.ATLAS_ARTIFACT_WORKER_PID_FD !== String(FD)) return false
  try {
    const st = fstatSync(FD)
    return st.isSocket() || st.isFIFO()
  } catch {
    return false
  }
}

if (reporting()) {
  const report = (line: string): void => {
    try { writeSync(FD, `${line}\n`) } catch { /* the service is gone; nothing to report to */ }
  }
  const track = (child: ChildProcess): void => {
    const pid = child.pid
    if (typeof pid !== 'number') return // the spawn failed: there is no process
    report(`S ${pid}`)
    child.once('exit', () => report(`E ${pid}`))
  }
  diagnosticsChannel.subscribe('child_process', message => {
    const child = (message as { process?: ChildProcess }).process
    if (!child) return
    // The channel publishes from the ChildProcess constructor, before spawn() assigns the pid; spawn() is synchronous, so
    // the pid is set by the time the current synchronous call finishes and this microtask runs.
    if (typeof child.pid === 'number') track(child)
    else queueMicrotask(() => track(child))
  })
}
