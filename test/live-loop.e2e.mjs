/**
 * The whole loop, over real HTTP and a real socket:
 *   page subscribes -> a pass runs -> the page is told, unprompted.
 *
 * The model call is injected (distill.complete), so no quota is spent and the
 * test is deterministic. Everything else is production code: apply(), the
 * watcher, the distill pass, the hub, the SSE route and the HTTP server.
 *
 * Run: node test/live-loop.e2e.mjs
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-live-loop-'))
const vault = join(sandbox, 'vault')
const store = join(sandbox, 'store')
mkdirSync(vault, { recursive: true })
mkdirSync(store, { recursive: true })

// HERMETIC: persistThroughCli() shells out to the real `mnemon import`, which
// honours MNEMON_DATA_DIR. Without this the test would write synthetic insights
// into the user's REAL memory space - observed once during development, when a
// run left a fabricated conclusion in the live store. Redirect the CLI at a
// throwaway database so the test can exercise the write path and touch nothing.
const memoryDataDir = join(sandbox, 'mnemon-data')
mkdirSync(memoryDataDir, { recursive: true })
process.env.MNEMON_DATA_DIR = memoryDataDir
writeFileSync(join(vault, 'alpha.md'), '# Alpha\n\n' + '甲'.repeat(200), 'utf8')
writeFileSync(join(vault, 'beta.md'), '# Beta\n\n' + '乙'.repeat(200), 'utf8')

let mounted
const server = http.createServer((req, res) => {
  if (mounted === undefined) { res.writeHead(404); res.end(); return }
  mounted(req, res)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

const webServer = { register: ({ handler }) => { mounted = handler; return () => { mounted = undefined } } }
const connection = { requestRejection: () => undefined }
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

/** Records what the injected "model" was asked to do. */
const modelCalls = []
const complete = async (messages) => {
  modelCalls.push(messages.at(-1).content.split('\n')[0])
  return JSON.stringify({
    insights: [{ content: '由模型蒸馏出的一条自洽结论，内容足够完整。', category: 'fact', importance: 3, tags: [], entities: [] }],
  })
}

apply(ctx, {
  patchPath,
  roots: [vault],
  storeDirectory: store,
  log: () => {},
  // Automatic scheduling OFF on purpose: this test drives the pass by hand, the
  // same way the new 立即蒸馏 button does.
  distill: { enabled: true, automatic: false, autoContinue: false, complete, debounceMs: 10 },
  webServer,
  connection,
})

/** Open the stream and keep every frame that arrives. */
const frames = []
const stream = http.get({
  host: '127.0.0.1', port, path: '/mnemon-sync-monitor/events',
}, (res) => {
  assert.equal(res.statusCode, 200)
  res.setEncoding('utf8')
  let raw = ''
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
    }
  })
})
await new Promise((resolve) => stream.on('socket', () => setTimeout(resolve, 150)))

function post(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST' }, (res) => {
      let text = ''
      res.on('data', (c) => { text += c })
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }))
    })
    req.on('error', reject)
    req.end()
  })
}

const accepted = await post('/mnemon-sync-monitor/distill')
assert.equal(accepted.status, 202, 'trigger is accepted immediately')

// Wait for the pass to finish, driven entirely by the stream.
const deadline = Date.now() + 15000
while (Date.now() < deadline) {
  const done = frames.some((f) => f.event === 'state' && f.data.state.phase === 'finished')
  if (done) break
  await new Promise((resolve) => setTimeout(resolve, 50))
}

const states = frames.filter((f) => f.event === 'state').map((f) => f.data.state)
const activities = frames.filter((f) => f.event === 'activity').map((f) => f.data.message)

assert.ok(states.some((s) => s.phase === 'running'), 'page saw the pass start: ' + states.map((s) => s.phase).join(','))
assert.ok(states.some((s) => s.phase === 'finished'), 'page saw the pass finish: ' + states.map((s) => s.phase).join(','))
assert.ok(states.some((s) => s.current !== undefined && s.current !== null), 'page saw the file in flight')
assert.equal(modelCalls.length, 2, 'both notes were distilled')
assert.ok(activities.some((m) => m.includes('alpha.md')), 'activity names the note: ' + activities.join(' | '))
assert.ok(activities.some((m) => m.includes('开始蒸馏')), 'activity announces the pass')

const final = states.at(-1)
assert.equal(final.running, false)
assert.equal(final.insights.proposed, 2, 'two insights proposed')
assert.ok(final.coverage !== undefined && final.coverage !== null, 'coverage travelled with the stream')

console.log('frames:', frames.map((f) => f.event).join(','))
console.log('phases:', states.map((s) => s.phase).join(' -> '))
console.log('activity:', activities.join(' | '))

stream.destroy()
ctx._dispose?.()
await new Promise((resolve) => server.close(resolve))
rmSync(sandbox, { recursive: true, force: true })
console.log('live-loop e2e: PASS')
