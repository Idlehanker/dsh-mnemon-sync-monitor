import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createHandler } from '../lib/server.js'

/** Minimal request/response doubles for the route table. */
function call(handler, { path, method = 'GET' }) {
  const req = new EventEmitter()
  req.url = '/mnemon-sync-monitor' + path
  req.method = method
  req.headers = {}
  const res = new EventEmitter()
  res.chunks = []
  res.headers = {}
  res.status = undefined
  res.writableEnded = false
  res.destroyed = false
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers || {}; return res }
  res.write = (chunk) => { res.chunks.push(String(chunk)); return true }
  res.end = (chunk) => { if (chunk !== undefined) res.chunks.push(String(chunk)); res.writableEnded = true }
  res.body = () => {
    const text = res.chunks.join('')
    try { return JSON.parse(text) } catch { return text }
  }
  return handler(req, res).then(() => ({ status: res.status, body: res.body(), res }))
}

const silent = () => {}

test('an unauthenticated request is rejected before any path matching', async () => {
  const handler = createHandler({
    getRoots: () => [],
    setRoots: async () => ({}),
    reject: () => 401,
    attachEvents: () => { throw new Error('must not be reached') },
  })
  const result = await call(handler, { path: '/events' })
  assert.equal(result.status, 401)
})

test('GET /events hands the response to attachEvents and does not answer it', async () => {
  let attached = 0
  const handler = createHandler({
    getRoots: () => [],
    setRoots: async () => ({}),
    reject: () => undefined,
    attachEvents: (req, res) => {
      attached += 1
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('event: hello\ndata: {}\n\n')
      // Deliberately left open - this is a stream, not a request/response.
    },
  })
  const result = await call(handler, { path: '/events' })
  assert.equal(attached, 1)
  assert.equal(result.status, 200)
  assert.match(result.res.body(), /event: hello/)
})

test('POST /events is refused without touching the stream', async () => {
  let attached = 0
  const handler = createHandler({
    getRoots: () => [],
    setRoots: async () => ({}),
    reject: () => undefined,
    attachEvents: () => { attached += 1 },
  })
  const result = await call(handler, { path: '/events', method: 'POST' })
  assert.equal(result.status, 405)
  assert.equal(attached, 0)
})

test('POST /distill answers 202 immediately and does not wait for the pass', async () => {
  let resolved = false
  const handler = createHandler({
    getRoots: () => [],
    setRoots: async () => ({}),
    reject: () => undefined,
    // Never settles: a real pass can run for minutes. The route must not wait.
    distill: () => new Promise((resolve) => { resolved = resolve }),
    distillStatus: () => ({ running: false, enabled: true }),
  })
  const result = await call(handler, { path: '/distill', method: 'POST' })
  assert.equal(result.status, 202)
  assert.equal(result.body.accepted, true)
  assert.equal(resolved instanceof Function, true)
})

test('POST /distill refuses to stack a second pass on a running one', async () => {
  let started = 0
  const handler = createHandler({
    getRoots: () => [],
    setRoots: async () => ({}),
    reject: () => undefined,
    distill: async () => { started += 1 },
    distillStatus: () => ({ running: true, enabled: true }),
  })
  const result = await call(handler, { path: '/distill', method: 'POST' })
  assert.equal(result.status, 409)
  assert.equal(result.body.code, 'already-running')
  assert.equal(started, 0)
})

test('/state carries the live hub state so a first paint matches the stream', async () => {
  const handler = createHandler({
    getRoots: () => ['C:\\vault'],
    setRoots: async () => ({}),
    reject: () => undefined,
    distillStatus: () => ({ enabled: true, live: { phase: 'running', current: { file: 'a.md' } } }),
  })
  const result = await call(handler, { path: '/state' })
  assert.equal(result.status, 200)
  assert.equal(result.body.distill.live.phase, 'running')
})

test('the existing routes still answer as before', async () => {
  const handler = createHandler({
    getRoots: () => [],
    setRoots: async () => ({}),
    reject: () => undefined,
    rescan: () => {},
    coverage: async () => ({ scanned: 3, distilled: 1, pending: 2 }),
  })
  const rescan = await call(handler, { path: '/rescan', method: 'POST' })
  assert.equal(rescan.status, 200)
  const cov = await call(handler, { path: '/coverage' })
  assert.equal(cov.status, 200)
  assert.equal(cov.body.coverage.pending, 2)
  const missing = await call(handler, { path: '/nope' })
  assert.equal(missing.status, 404)
})
