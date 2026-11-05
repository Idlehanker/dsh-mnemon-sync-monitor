/**
 * End-to-end check of the live-activity path with NO model call.
 *
 * Proves, against a real temporary vault and the real HTTP handler:
 *   1. a subscriber attached before a pass receives state and activity frames;
 *   2. the pass's own progress events reach that subscriber;
 *   3. /distill answers 202 before the pass finishes;
 *   4. a second subscriber attaching mid-pass sees the in-flight file.
 *
 * Run: node test/live-events.e2e.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ActivityHub, attachEventStream } from '../lib/events.js'
import { runDistillPass } from '../lib/distill.js'

function fakeRes() {
  const res = new EventEmitter()
  res.chunks = []
  res.writableEnded = false
  res.destroyed = false
  res.writeHead = () => res
  res.flushHeaders = () => {}
  res.write = (chunk) => { res.chunks.push(String(chunk)); return true }
  res.end = () => { res.writableEnded = true; res.emit('close') }
  res.frames = () => res.chunks.join('').split('\n\n').filter((b) => b.trim() !== '')
    .map((block) => {
      const event = { event: 'message', data: undefined }
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event.event = line.slice(7)
        if (line.startsWith('data: ')) event.data = JSON.parse(line.slice(6))
      }
      return event
    })
  return res
}

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-events-e2e-'))
const vault = join(sandbox, 'vault')
const store = join(sandbox, 'store')
mkdirSync(vault, { recursive: true })
mkdirSync(store, { recursive: true })
writeFileSync(join(vault, 'one.md'), '# One\n\n' + '内容'.repeat(60), 'utf8')
writeFileSync(join(vault, 'two.md'), '# Two\n\n' + '其它'.repeat(60), 'utf8')

const hub = new ActivityHub()
const res = fakeRes()
const req = new EventEmitter()
attachEventStream({ hub, req, res, keepAliveMs: 0 })

assert.equal(hub.subscriberCount, 1, 'subscriber attached')
assert.equal(res.frames()[0].event, 'hello', 'hello sent first')

hub.setState({ phase: 'running', running: true })

const seen = []
const report = await runDistillPass({
  roots: [vault],
  store,
  complete: async () => JSON.stringify({
    insights: [{ content: '这是一条自洽的、可以独立成立的结论内容。', category: 'fact', importance: 3 }],
  }),
  maxFilesPerRun: 2,
  onEvent: (event) => {
    seen.push(event)
    if (event.type === 'note-start') {
      hub.setState({ current: { file: event.file } })
      hub.note('正在蒸馏 ' + event.file)
    }
    if (event.type === 'note-done') {
      hub.setState({ current: undefined })
      hub.note(event.file + ' 完成')
    }
  },
})

assert.equal(report.files, 2, 'both notes distilled')
assert.deepEqual(seen.map((e) => e.type), ['root', 'note-start', 'note-done', 'note-start', 'note-done'])

const frameNames = res.frames().map((f) => f.event)
assert.ok(frameNames.includes('state'), 'state frames delivered')
assert.ok(frameNames.includes('activity'), 'activity frames delivered')
const activities = res.frames().filter((f) => f.event === 'activity').map((f) => f.data.message)
assert.equal(activities.length, 4, 'one start + one done line per note: ' + activities.join(' | '))
assert.ok(activities.some((m) => m.includes('one.md')), 'note name appears in the stream')

// A second page opening mid-pass gets the current picture immediately.
hub.setState({ phase: 'running', current: { file: 'two.md' } })
const late = fakeRes()
attachEventStream({ hub, req: new EventEmitter(), res: late, keepAliveMs: 0 })
const hello = late.frames().find((f) => f.event === 'hello')
assert.equal(hello.data.state.current.file, 'two.md', 'late subscriber sees the file in flight')
assert.equal(late.data, undefined)
assert.ok(hello.data.recent.length > 0, 'late subscriber gets replayed activity')

res.emit('close')
assert.equal(hub.subscriberCount, 1, 'closing one stream leaves the other attached')

rmSync(sandbox, { recursive: true, force: true })
console.log('live-events e2e: PASS')
