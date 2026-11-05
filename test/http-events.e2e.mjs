/**
 * Boot the plugin against a fake Host and speak HTTP to it over a real socket.
 *
 * This is the closest check to the live Host that does not require restarting
 * it: apply() runs with a webServer double that mounts the registered prefix
 * handler on a real node:http server, and a connection double that implements
 * the trust fence the Host provides. Then we connect an SSE client the same way
 * a browser would.
 *
 * Run: node test/http-events.e2e.mjs
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-http-events-'))
const vault = join(sandbox, 'vault')
const store = join(sandbox, 'store')
mkdirSync(vault, { recursive: true })
mkdirSync(store, { recursive: true })
writeFileSync(join(vault, 'note.md'), '# Note\n\n' + '正文内容'.repeat(120), 'utf8')

/** Mount the plugin's prefix handler on a real server, the way the Host does. */
let mounted
const server = http.createServer((req, res) => {
  if (mounted === undefined) { res.writeHead(404); res.end(); return }
  mounted(req, res)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

const webServer = {
  register: ({ kind, path, handler }) => {
    assert.equal(kind, 'prefix')
    assert.equal(path, '/mnemon-sync-monitor')
    mounted = handler
    return () => { mounted = undefined }
  },
}

// The trust fence double: reject anything without the header the Host injects.
const connection = {
  requestRejection: (req) => (req.headers['x-trusted'] === 'yes' ? undefined : 401),
}

// Cordis exposes services as properties on the context, which is how index.js
// reads them (ctx.webServer / ctx.connection).
// HERMETIC: apply() prefers the distillation switch persisted in the profile
// patch over the one passed in `config`. Without a scratch patchPath this test
// would read the user's real profile and could fire a real pass against the real
// memory store.
const patchPath = join(sandbox, 'cordis.patch.yml')
writeFileSync(patchPath, '- id: mnemon-sync-monitor\n  config:\n    roots: []\n', 'utf8')

const ctx = {
  get: () => undefined,
  effect: (fn) => { ctx._dispose = fn() },
  webServer,
  connection,
}

apply(ctx, {
  patchPath,
  roots: [vault],
  storeDirectory: store,
  // Distillation stays off: this test is about the transport, not the model.
  distill: { enabled: false },
  log: () => {},
  webServer,
  connection,
})

/** Collect SSE frames until predicate passes or the deadline expires. */
function collect(path, headers = { 'x-trusted': 'yes' }) {
  return new Promise((resolve, reject) => {
    const frames = []
    let raw = ''
    const req = http.get({ host: '127.0.0.1', port, path, headers }, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        resolve({ status: res.statusCode, frames })
        return
      }
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        raw += chunk
        let cut
        while ((cut = raw.indexOf('\n\n')) >= 0) {
          const block = raw.slice(0, cut)
          raw = raw.slice(cut + 2)
          if (block.trim() === '' || block.startsWith(':')) continue
          const frame = { event: 'message', data: undefined }
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) frame.event = line.slice(7)
            if (line.startsWith('data: ')) frame.data = JSON.parse(line.slice(6))
          }
          frames.push(frame)
          if (frame.event === 'hello') {
            // One frame is enough to prove the stream opened and is ordered.
            req.destroy()
            resolve({ status: res.statusCode, frames })
            return
          }
        }
      })
      res.on('error', () => resolve({ status: res.statusCode, frames }))
    })
    req.on('error', reject)
    setTimeout(() => { req.destroy(); resolve({ status: undefined, frames }) }, 4000)
  })
}

// 1. The fence rejects an untrusted caller before anything runs.
const denied = await collect('/mnemon-sync-monitor/events', {})
assert.equal(denied.status, 401, 'untrusted request must be rejected')

// 2. A trusted caller gets an SSE stream and a hello snapshot.
const hello = await collect('/mnemon-sync-monitor/events')
assert.equal(hello.status, 200, 'trusted request must stream')
assert.equal(hello.frames[0].event, 'hello', 'first frame is hello')
assert.ok(hello.frames[0].data.state !== undefined, 'hello carries state')

// 3. /state over real HTTP reports the live object too.
const state = await new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: '/mnemon-sync-monitor/state', headers: { 'x-trusted': 'yes' } }, (res) => {
    let text = ''
    res.setEncoding('utf8')
    res.on('data', (c) => { text += c })
    res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }))
  }).on('error', reject)
})
assert.equal(state.status, 200)
assert.ok(state.body.distill.live !== undefined, '/state exposes live state')

// 4. POST /distill answers 202 without waiting for a pass.
const started = await new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: '/mnemon-sync-monitor/distill', method: 'POST', headers: { 'x-trusted': 'yes' } }, (res) => {
    let text = ''
    res.setEncoding('utf8')
    res.on('data', (c) => { text += c })
    res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }))
  })
  req.on('error', reject)
  req.end()
})
assert.equal(started.status, 202, '/distill is accepted, not awaited')

ctx._dispose?.()
await new Promise((resolve) => server.close(resolve))
rmSync(sandbox, { recursive: true, force: true })
console.log('http-events e2e: PASS')
