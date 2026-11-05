import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createHandler } from '../lib/server.js'

/** Minimal request/response doubles, matching routes.test.js. */
function call(handler, { path, method = 'GET', body }) {
  const req = new EventEmitter()
  req.url = '/mnemon-sync-monitor' + path
  req.method = method
  req.headers = {}
  req.pause = () => {}
  const res = new EventEmitter()
  res.chunks = []
  res.status = undefined
  res.writableEnded = false
  res.writeHead = (status) => { res.status = status; return res }
  res.write = (chunk) => { res.chunks.push(String(chunk)); return true }
  res.end = (chunk) => { if (chunk !== undefined) res.chunks.push(String(chunk)); res.writableEnded = true }
  res.body = () => {
    const text = res.chunks.join('')
    try { return JSON.parse(text) } catch { return text }
  }
  const pending = handler(req, res)
  // The handler reads the body asynchronously; emit it on the next tick.
  if (body !== undefined) {
    setImmediate(() => {
      req.emit('data', Buffer.from(JSON.stringify(body)))
      req.emit('end')
    })
  }
  return pending.then(() => ({ status: res.status, body: res.body(), res }))
}

const base = { getRoots: () => [], setRoots: async () => ({}), reject: () => undefined }

test('GET /efforts reports the model tiers and the effective choice', async () => {
  const handler = createHandler({
    ...base,
    listEfforts: async () => ({
      efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
      supported: true,
      modelDefault: 'high',
      effective: 'low',
      model: 'workbuddy/deepseek-v4.1-flash',
    }),
  })
  const result = await call(handler, { path: '/efforts' })
  assert.equal(result.status, 200)
  assert.equal(result.body.effort.effective, 'low')
  assert.equal(result.body.effort.modelDefault, 'high')
  assert.equal(result.body.effort.efforts.length, 2)
})

test('GET /efforts reports a model without tiers as unsupported', async () => {
  const handler = createHandler({
    ...base,
    // A model that accepts no reasoning control must not be given a fake menu:
    // offering tiers it rejects would make the control silently do nothing.
    listEfforts: async () => ({ efforts: [], supported: false, modelDefault: null, effective: 'low' }),
  })
  const result = await call(handler, { path: '/efforts' })
  assert.equal(result.status, 200)
  assert.equal(result.body.effort.supported, false)
  assert.deepEqual(result.body.effort.efforts, [])
})

test('POST /effort persists the chosen tier', async () => {
  let written
  const handler = createHandler({
    ...base,
    setDistillEffort: (effort) => { written = effort; return { changed: true } },
    distillStatus: () => ({ reasoningEffort: 'high' }),
  })
  const result = await call(handler, { path: '/effort', method: 'POST', body: { effort: 'high' } })
  assert.equal(result.status, 200)
  assert.equal(written, 'high')
  assert.equal(result.body.effort, 'high')
  assert.equal(result.body.status.reasoningEffort, 'high')
})

test('POST /effort with null clears the override', async () => {
  let written = 'sentinel'
  const handler = createHandler({
    ...base,
    setDistillEffort: (effort) => { written = effort; return { changed: true } },
  })
  const result = await call(handler, { path: '/effort', method: 'POST', body: { effort: null } })
  assert.equal(result.status, 200)
  // null here is meaningful: it means "send no reasoning_effort at all", which
  // is not the same request as sending the string 'default'.
  assert.equal(written, null)
  assert.equal(result.body.effort, null)
})

test('POST /effort rejects an empty or non-string tier', async () => {
  let written
  const handler = createHandler({
    ...base,
    setDistillEffort: (effort) => { written = effort; return { changed: true } },
  })
  for (const bad of ['', '   ', 42, {}]) {
    const result = await call(handler, { path: '/effort', method: 'POST', body: { effort: bad } })
    assert.equal(result.status, 400)
    assert.equal(result.body.code, 'invalid-effort')
  }
  assert.equal(written, undefined, 'an invalid tier must never reach the writer')
})

test('GET /effort is refused, it is a write', async () => {
  const handler = createHandler({
    ...base,
    setDistillEffort: () => ({ changed: true }),
  })
  const result = await call(handler, { path: '/effort' })
  assert.equal(result.status, 405)
})

test('an unwired effort control answers 501 rather than crashing', async () => {
  const handler = createHandler({ ...base })
  const get = await call(handler, { path: '/efforts' })
  assert.equal(get.status, 501)
  const post = await call(handler, { path: '/effort', method: 'POST', body: { effort: 'low' } })
  assert.equal(post.status, 501)
})
