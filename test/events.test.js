import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { ActivityHub, writeEvent, attachEventStream } from '../lib/events.js'

/** A response double that records writes and lets the test end it. */
function fakeRes() {
  const res = new EventEmitter()
  res.chunks = []
  res.headers = undefined
  res.writableEnded = false
  res.destroyed = false
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; return res }
  res.flushHeaders = () => {}
  res.write = (chunk) => { res.chunks.push(chunk); return true }
  res.end = () => { res.writableEnded = true; res.emit('close') }
  res.text = () => res.chunks.join('')
  return res
}

function fakeReq() {
  const req = new EventEmitter()
  req.url = '/mnemon-sync-monitor/events'
  req.method = 'GET'
  return req
}

/** Parse SSE frames from a raw transcript. */
function frames(text) {
  return text
    .split('\n\n')
    .filter((block) => block.trim() !== '')
    .map((block) => {
      const lines = block.split('\n')
      const frame = { comment: false, event: 'message', data: undefined }
      for (const line of lines) {
        if (line.startsWith(':')) { frame.comment = true; continue }
        if (line.startsWith('event: ')) frame.event = line.slice(7)
        if (line.startsWith('data: ')) frame.data = JSON.parse(line.slice(6))
      }
      return frame
    })
}

test('the hub delivers state to every subscriber and survives one that throws', () => {
  const hub = new ActivityHub()
  const seenA = []
  const seenB = []
  hub.subscribe((event) => seenA.push(event))
  hub.subscribe(() => { throw new Error('broken page') })
  hub.subscribe((event) => seenB.push(event))

  hub.setState({ phase: 'running', running: true })

  assert.equal(seenA.length, 1)
  assert.equal(seenB.length, 1)
  assert.equal(seenA[0].kind, 'state')
  assert.equal(hub.state.phase, 'running')
  // The throwing subscriber is dropped; the two healthy ones stay attached.
  assert.equal(hub.subscriberCount, 2)
})

test('unsubscribing stops delivery and publishing with no subscribers still works', () => {
  const hub = new ActivityHub()
  const seen = []
  const off = hub.subscribe((event) => seen.push(event))
  hub.note('first')
  off()
  hub.note('second')
  assert.deepEqual(seen.map((e) => e.message), ['first'])
  assert.equal(hub.subscriberCount, 0)
  // Nothing listens, yet the call must not throw and the ring must still record.
  assert.equal(hub.history.length, 2)
})

test('activity history is bounded and snapshots replay it', () => {
  const hub = new ActivityHub({ historyLimit: 5 })
  for (let i = 0; i < 20; i += 1) hub.note('line ' + i)
  assert.equal(hub.history.length, 5)
  assert.equal(hub.history.at(-1).message, 'line 19')
  const snapshot = hub.snapshot()
  assert.equal(snapshot.recent.length, 5)
  assert.equal(snapshot.state.phase, 'idle')
})

test('sequence numbers are monotonic across every event kind', () => {
  const hub = new ActivityHub()
  const seen = []
  hub.subscribe((event) => seen.push(event.seq))
  hub.setState({ phase: 'queued' })
  hub.note('a')
  hub.setState({ phase: 'running' })
  for (let i = 1; i < seen.length; i += 1) assert.ok(seen[i] > seen[i - 1])
})

test('a new subscriber receives the current state immediately, not on the next tick', () => {
  const hub = new ActivityHub()
  hub.setState({ phase: 'running', current: { file: 'a.md' } })
  hub.note('working')
  const res = fakeRes()
  const req = fakeReq()
  attachEventStream({ hub, req, res, keepAliveMs: 0 })

  const parsed = frames(res.text())
  const hello = parsed.find((f) => f.event === 'hello')
  assert.ok(hello !== undefined, 'hello frame expected')
  assert.equal(hello.data.state.phase, 'running')
  assert.equal(hello.data.state.current.file, 'a.md')
  assert.equal(hello.data.recent.length, 1)
  // The connection is subscribed as a side effect of attaching.
  assert.equal(hub.subscriberCount, 1)
  req.emit('close')
  assert.equal(hub.subscriberCount, 0)
})

test('attached responses get later state and activity frames', () => {
  const hub = new ActivityHub()
  const res = fakeRes()
  attachEventStream({ hub, req: fakeReq(), res, keepAliveMs: 0 })
  res.chunks.length = 0
  hub.setState({ phase: 'running' })
  hub.note('正在蒸馏 a.md')
  const parsed = frames(res.text())
  assert.deepEqual(parsed.map((f) => f.event), ['state', 'activity'])
  assert.equal(parsed[1].data.message, '正在蒸馏 a.md')
})

test('closing the response detaches it, so a dead page costs nothing', () => {
  const hub = new ActivityHub()
  const res = fakeRes()
  const req = fakeReq()
  attachEventStream({ hub, req, res, keepAliveMs: 0 })
  assert.equal(hub.subscriberCount, 1)
  res.end()
  assert.equal(hub.subscriberCount, 0)
  res.chunks.length = 0
  hub.setState({ phase: 'idle' })
  assert.equal(res.chunks.length, 0)
})

test('writeEvent refuses a closed response instead of throwing', () => {
  const res = fakeRes()
  assert.equal(writeEvent(res, 'state', { a: 1 }), true)
  res.writableEnded = true
  assert.equal(writeEvent(res, 'state', { a: 2 }), false)
})

test('a message containing newlines cannot break the frame encoding', () => {
  const res = fakeRes()
  writeEvent(res, 'activity', { message: 'line1\nline2\n\ndata: injected' })
  const raw = res.text()
  // Exactly one frame: the JSON encoding keeps the payload on one data line.
  assert.equal(raw.split('\n\n').length, 2)
  const parsed = frames(raw)
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].data.message, 'line1\nline2\n\ndata: injected')
})

test('the stream sets the headers that stop buffering and caching', () => {
  const hub = new ActivityHub()
  const res = fakeRes()
  attachEventStream({ hub, req: fakeReq(), res, keepAliveMs: 0 })
  assert.equal(res.status, 200)
  assert.match(res.headers['content-type'], /text\/event-stream/)
  assert.match(res.headers['cache-control'], /no-transform/)
  assert.equal(res.headers['x-accel-buffering'], 'no')
})
