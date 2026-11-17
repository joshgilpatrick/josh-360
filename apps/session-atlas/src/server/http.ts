import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import type { AtlasDb } from '../db/database.ts'
import type { AtlasConfig } from '../config.ts'
import type { Logger } from '../util/log.ts'

export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

export type RouteContext = {
  req: IncomingMessage; res: ServerResponse; params: Record<string, string>; url: URL
  json<T>(): Promise<T>; send(status: number, body: unknown): void
}
export type RouteHandler = (ctx: RouteContext) => Promise<void> | void
type Route = { method: string; segments: string[]; handler: RouteHandler }

const MAX_BODY = 64 * 1024
const ALLOWED_HOST_RE = /^(127\.0\.0\.1|localhost)(:\d+)?$/
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH'])

export class Router {
  private routes: Route[] = []
  add(method: string, pattern: string, handler: RouteHandler): void {
    this.routes.push({ method, segments: pattern.split('/').filter(Boolean), handler })
  }
  match(method: string, pathname: string): { handler: RouteHandler; params: Record<string, string> } | null {
    const parts = pathname.split('/').filter(Boolean)
    for (const r of this.routes) {
      if (r.method !== method || r.segments.length !== parts.length) continue
      const params: Record<string, string> = {}
      let ok = true
      for (let i = 0; i < parts.length; i++) {
        const seg = r.segments[i]!, part = parts[i]!
        if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(part)
        else if (seg !== part) { ok = false; break }
      }
      if (ok) return { handler: r.handler, params }
    }
    return null
  }
}

export function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let rejected = false
    req.on('data', (c: Buffer) => {
      if (rejected) return
      size += c.length
      if (size > MAX_BODY) { rejected = true; reject(new HttpError(413, 'body too large')); return }
      chunks.push(c)
    })
    req.on('end', () => {
      if (rejected) return
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') as T) }
      catch { reject(new HttpError(400, 'invalid JSON')) }
    })
    req.on('error', reject)
  })
}

export function createAtlasServer(deps: { db: AtlasDb; config: AtlasConfig; log: Logger; router?: Router }) {
  const router = deps.router ?? new Router()
  // Updated once listen() resolves the real (possibly ephemeral, e.g. port 0 in tests) port;
  // the Origin allow-list must match what the server actually bound, not the requested config.
  let boundPort = deps.config.port
  router.add('GET', '/api/health', ctx => {
    const n = (deps.db.raw.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n
    const j = deps.db.raw.prepare(`SELECT
        COALESCE(SUM(state = 'pending'), 0) AS pending, COALESCE(SUM(state = 'running'), 0) AS running,
        COALESCE(SUM(state = 'quarantined'), 0) AS quarantined, MAX(updated_at) AS last
      FROM worker_jobs`).get() as { pending: number; running: number; quarantined: number; last: string | null }
    ctx.send(200, {
      ok: true, version: '0.1.0', dbPath: deps.db.path, sessions: n,
      jobs: { pending: j.pending, running: j.running, quarantined: j.quarantined }, lastRunAt: j.last ?? null,
    })
  })
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${deps.config.host}`)
    const send = (status: number, body: unknown) => {
      const text = JSON.stringify(body)
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      res.end(text)
    }
    // Localhost-trust posture: the hook and other local tools never send an Origin header or a
    // foreign Host, and always send a JSON content-type on writes. A browser tab does send
    // Origin/Host, so these checks stop it from forging events via a same-origin-exempt "simple
    // request" (e.g. a bare POST with a non-JSON content-type) or DNS rebinding.
    const hostHeader = req.headers.host ?? ''
    if (!ALLOWED_HOST_RE.test(hostHeader)) { send(400, { error: 'bad host' }); return }
    const origin = req.headers.origin
    if (origin !== undefined && origin !== `http://127.0.0.1:${boundPort}` && origin !== `http://localhost:${boundPort}`) {
      send(403, { error: 'forbidden origin' }); return
    }
    const method = req.method ?? 'GET'
    if (BODY_METHODS.has(method) && !(req.headers['content-type'] ?? '').startsWith('application/json')) {
      send(415, { error: 'unsupported content type' }); return
    }
    try {
      // router.match decodeURIComponent's each :param segment, which throws URIError on a
      // malformed % sequence (e.g. "/api/x/%E0%A4%A") — that must land in this try, or it
      // becomes an unhandled rejection that kills the request and never responds.
      const m = router.match(method, url.pathname)
      if (!m) { send(404, { error: 'not found' }); return }
      await m.handler({ req, res, params: m.params, url, json: () => readJsonBody(req), send })
    } catch (err) {
      if (res.headersSent) { res.end(); return }
      if (err instanceof HttpError) send(err.status, { error: err.message })
      else if (err instanceof URIError) send(400, { error: 'malformed request path' })
      else { deps.log.error('route failed', { path: url.pathname, err: String(err) }); send(500, { error: 'internal error' }) }
    }
  })
  server.keepAliveTimeout = 5000
  return {
    server, router,
    listen: () => new Promise<number>((resolve, reject) => {
      server.once('error', reject)
      server.listen(deps.config.port, deps.config.host, () => {
        const addr = server.address()
        boundPort = typeof addr === 'object' && addr ? addr.port : deps.config.port
        resolve(boundPort)
      })
    }),
    close: () => new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve()))),
  }
}
