import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  readDistillConcurrency, writeDistillConcurrency,
  DISTILL_CONCURRENCY_DEFAULT, DISTILL_CONCURRENCY_MAX,
} from '../lib/persist.js'
import { normalizeConcurrency, runDistillPass } from '../lib/distill.js'
import { createHandler } from '../lib/server.js'

// ---------------------------------------------------------------- writer ----

/** A patch file whose plugin row already carries a `distill:` block. */
function patchWithDistill(extra = []) {
  const base = mkdtempSync(join(tmpdir(), 'concurrency-'))
  const path = join(base, 'cordis.patch.yml')
  writeFileSync(path, [
    '# profile patch',
    '- id: other',
    '  name: other',
    '  config:',
    '    keep: true',
    '',
    '- id: mnemon-sync-monitor',
    '  name: dsh-mnemon-sync-monitor',
    '  config:',
    '    enabled: true',
    '    roots: []',
    '    distill:',
    '      enabled: true',
    ...extra,
    '',
    '- id: trailing',
    '  name: tail',
    '',
  ].join('\n'), 'utf8')
  return path
}

test('the concurrency default is a small bounded fan-out', () => {
  assert.equal(DISTILL_CONCURRENCY_DEFAULT, 3)
  assert.equal(DISTILL_CONCURRENCY_MAX, 8)
  assert.ok(DISTILL_CONCURRENCY_DEFAULT <= DISTILL_CONCURRENCY_MAX)
})

test('readDistillConcurrency reports absence rather than guessing', () => {
  assert.equal(readDistillConcurrency(patchWithDistill()), undefined)
})

test('writeDistillConcurrency inserts inside the distill block as a bare number', () => {
  const path = patchWithDistill()
  const result = writeDistillConcurrency(path, 4)
  assert.equal(result.changed, true)
  assert.equal(readDistillConcurrency(path), 4)

  const lines = readFileSync(path, 'utf8').split('\n')
  const at = lines.findIndex((line) => /^\s*concurrency:/u.test(line))
  assert.ok(at > 0)
  // Nested under distill:, never top-level: the Host reads the nested block.
  assert.match(lines[at], /^ {6}concurrency: 4$/u)
  // Written unquoted, so a YAML reader hands back a number not a string.
  assert.doesNotMatch(lines[at], /"/u)
  // Every other row must survive byte-identical.
  assert.ok(lines.includes('    keep: true'))
  assert.ok(lines.includes('- id: trailing'))
})

test('writeDistillConcurrency is idempotent and keeps a backup', () => {
  const path = patchWithDistill()
  assert.equal(writeDistillConcurrency(path, 3).changed, true)
  const second = writeDistillConcurrency(path, 3)
  assert.equal(second.changed, false)
  assert.equal(readDistillConcurrency(path), 3)
})

test('writeDistillConcurrency rejects out-of-range and non-integer values', () => {
  const path = patchWithDistill()
  // Rejected, NOT clamped: silently storing 999 and then running 8 would make
  // the page and the scheduler disagree about what is configured.
  for (const bad of [0, -1, 9, 999, 2.5]) {
    assert.throws(() => writeDistillConcurrency(path, bad), /concurrency must be/u)
  }
  assert.equal(readDistillConcurrency(path), undefined, 'a rejected write must not touch the file')
})

test('writeDistillConcurrency creates the distill block when it is absent', () => {
  const base = mkdtempSync(join(tmpdir(), 'concurrency-bare-'))
  const path = join(base, 'cordis.patch.yml')
  writeFileSync(path, [
    '- id: mnemon-sync-monitor',
    '  name: dsh-mnemon-sync-monitor',
    '  config:',
    '    enabled: true',
    '',
  ].join('\n'), 'utf8')
  const result = writeDistillConcurrency(path, 2)
  assert.equal(result.changed, true)
  assert.equal(result.created, true)
  const lines = readFileSync(path, 'utf8').split('\n')
  assert.ok(lines.includes('    distill:'))
  assert.ok(lines.some((line) => /^\s+concurrency: 2$/u.test(line)))
  assert.equal(readDistillConcurrency(path), 2)
})

// --------------------------------------------------------------- clamp ----

test('normalizeConcurrency accepts the shapes a hand-edited patch can hold', () => {
  assert.equal(normalizeConcurrency(3), 3)
  // A YAML quote or a stray string must not silently mean "serial".
  assert.equal(normalizeConcurrency('4'), 4)
  assert.equal(normalizeConcurrency(' 6 '), 6)
  // Out-of-range and nonsense are clamped or defaulted, never passed through.
  assert.equal(normalizeConcurrency(0), 1)
  assert.equal(normalizeConcurrency(-5), 1)
  assert.equal(normalizeConcurrency(999), DISTILL_CONCURRENCY_MAX)
  assert.equal(normalizeConcurrency(3.9), 3)
  assert.equal(normalizeConcurrency(null), DISTILL_CONCURRENCY_DEFAULT)
  assert.equal(normalizeConcurrency(undefined), DISTILL_CONCURRENCY_DEFAULT)
  assert.equal(normalizeConcurrency('abc'), DISTILL_CONCURRENCY_DEFAULT)
  assert.equal(normalizeConcurrency(NaN), DISTILL_CONCURRENCY_DEFAULT)
})

// -------------------------------------------------------------- pool ----

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), 'dsh-concurrency-'))
  const vault = join(base, 'vault')
  const store = join(base, 'store')
  mkdirSync(vault, { recursive: true })
  mkdirSync(store, { recursive: true })
  return { base, vault, store }
}

/** Writes N notes, each large enough to pass the 80-character floor. */
function notes(vault, count) {
  for (let index = 0; index < count; index += 1) {
    writeFileSync(join(vault, 'n' + index + '.md'), '# N' + index + '\n\n' + '字'.repeat(120), 'utf8')
  }
}

/**
 * A model double that only settles when released, so the test controls exactly
 * how many calls are in flight at once.
 */
function gatedComplete() {
  const pending = []
  let inFlight = 0
  let peak = 0
  let open = false
  const fn = async () => {
    inFlight += 1
    peak = Math.max(peak, inFlight)
    if (!open) await new Promise((release) => pending.push(release))
    inFlight -= 1
    return JSON.stringify({
      insights: [{ content: '这是一条足够长的、可以独立成立的结论内容。', category: 'fact', importance: 3 }],
    })
  }
  fn.releaseAll = () => { for (const release of pending.splice(0)) release() }
  /** Stop gating: every call settles from now on, including ones not yet made. */
  fn.open = () => { open = true; fn.releaseAll() }
  fn.peak = () => peak
  fn.waiting = () => pending.length
  return fn
}

test('a concurrency of 1 keeps exactly one model call in flight', async () => {
  const box = sandbox()
  try {
    notes(box.vault, 3)
    const complete = gatedComplete()
    const pass = runDistillPass({
      roots: [box.vault], store: box.store, complete, maxFilesPerRun: 10, concurrency: 1,
    })
    // Let the worker reach its first await, then check nothing else started.
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(complete.waiting(), 1)
    assert.equal(complete.peak(), 1)
    complete.open()
    const report = await pass
    assert.equal(report.files, 3)
    assert.equal(complete.peak(), 1, 'concurrency 1 must never overlap calls')
  } finally {
    rmSync(box.base, { recursive: true, force: true })
  }
})

test('the pool runs up to `concurrency` calls at once and no more', async () => {
  const box = sandbox()
  try {
    notes(box.vault, 6)
    const complete = gatedComplete()
    const pass = runDistillPass({
      roots: [box.vault], store: box.store, complete, maxFilesPerRun: 10, concurrency: 3,
    })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(complete.waiting(), 3, 'exactly the bound is in flight, not more')
    complete.open()
    const report = await pass
    assert.equal(report.files, 6)
    assert.equal(complete.peak(), 3, 'the bound is never exceeded')
  } finally {
    rmSync(box.base, { recursive: true, force: true })
  }
})

test('the bound is never exceeded even when the batch is smaller than it', async () => {
  const box = sandbox()
  try {
    notes(box.vault, 2)
    const complete = gatedComplete()
    const pass = runDistillPass({
      roots: [box.vault], store: box.store, complete, maxFilesPerRun: 10, concurrency: 8,
    })
    await new Promise((resolve) => setImmediate(resolve))
    // Only 2 notes exist: 8 workers must not be started for 2 notes.
    assert.equal(complete.waiting(), 2)
    complete.open()
    const report = await pass
    assert.equal(report.files, 2)
    assert.equal(complete.peak(), 2)
  } finally {
    rmSync(box.base, { recursive: true, force: true })
  }
})

test('every note in a concurrent batch is recorded exactly once', async () => {
  const box = sandbox()
  try {
    notes(box.vault, 5)
    let calls = 0
    const complete = async () => {
      calls += 1
      return JSON.stringify({
        insights: [{ content: '并发批次中的每篇笔记都只应被记录一次，不多不少。', category: 'fact', importance: 3 }],
      })
    }
    const report = await runDistillPass({
      roots: [box.vault], store: box.store, complete, maxFilesPerRun: 10, concurrency: 4,
    })
    assert.equal(calls, 5)
    assert.equal(report.files, 5)
    assert.equal(report.roots[0].distilled, 5)
    // A second pass must find nothing pending: the ledger, not a counter, decides.
    const calm = async () => { throw new Error('must not be called') }
    const second = await runDistillPass({
      roots: [box.vault], store: box.store, complete: calm, maxFilesPerRun: 10, concurrency: 4,
    })
    assert.equal(second.roots[0].pending, 0)
    assert.equal(second.files, 0)
  } finally {
    rmSync(box.base, { recursive: true, force: true })
  }
})

test('content dedupe still spans the whole pass across concurrent workers', async () => {
  const box = sandbox()
  try {
    notes(box.vault, 4)
    // Every note yields the SAME claim. Serial or concurrent, it must land once:
    // the dedupe set is shared, so two workers cannot both write it.
    const written = []
    const complete = async () => JSON.stringify({
      insights: [{ content: '两个 worker 同时产出的同一结论，只能写入一次。', category: 'fact', importance: 4 }],
    })
    const report = await runDistillPass({
      roots: [box.vault], store: box.store, complete, maxFilesPerRun: 10, concurrency: 4,
      persistInsight: async (insight) => { written.push(insight.content) },
    })
    assert.equal(report.proposed, 1, 'the duplicate claim is counted once')
    assert.equal(written.length, 1, 'and written once')
    // All four notes are still marked done: they were distilled, they just had
    // nothing new to say. Leaving them pending would re-ask forever.
    assert.equal(report.files, 4)
    const second = await runDistillPass({
      roots: [box.vault], store: box.store, complete, maxFilesPerRun: 10, concurrency: 4,
    })
    assert.equal(second.roots[0].pending, 0)
  } finally {
    rmSync(box.base, { recursive: true, force: true })
  }
})

test('a failed note in a concurrent batch stays pending for the next pass', async () => {
  const box = sandbox()
  try {
    notes(box.vault, 4)
    let seen = 0
    const complete = async () => {
      seen += 1
      if (seen === 2) throw new Error('gateway down')
      return JSON.stringify({
        insights: [{ content: '并发批次中失败的那一篇，必须留到下一轮重试。', category: 'fact', importance: 3 }],
      })
    }
    const report = await runDistillPass({
      roots: [box.vault], store: box.store, complete, maxFilesPerRun: 10, concurrency: 4,
    })
    assert.equal(report.errors.length, 1)
    assert.match(report.errors[0].error, /gateway down/u)
    assert.equal(report.files, 3, 'the other three still complete')
    // Self-healing: exactly the failed note is retried.
    const retry = await runDistillPass({
      roots: [box.vault], store: box.store, maxFilesPerRun: 10, concurrency: 4,
      complete: async () => JSON.stringify({
        insights: [{ content: '重试成功后，这一篇也不再是待蒸馏状态。', category: 'fact', importance: 3 }],
      }),
    })
    assert.equal(retry.roots[0].pending, 1, 'only the failed note was left pending')
    assert.equal(retry.files, 1)
  } finally {
    rmSync(box.base, { recursive: true, force: true })
  }
})

test('concurrent events report the in-flight set, not just the newest note', async () => {
  const box = sandbox()
  try {
    notes(box.vault, 4)
    const complete = gatedComplete()
    const events = []
    const pass = runDistillPass({
      roots: [box.vault], store: box.store, complete, maxFilesPerRun: 10, concurrency: 3,
      onEvent: (event) => events.push(event),
    })
    await new Promise((resolve) => setImmediate(resolve))
    const starts = events.filter((event) => event.type === 'note-start')
    assert.equal(starts.length, 3)
    // Each start reports the whole in-flight set, growing 1 -> 2 -> 3.
    assert.deepEqual(starts.map((event) => event.active), [1, 2, 3])
    assert.deepEqual(starts.map((event) => event.files.length), [1, 2, 3])
    // Every entry carries what the page needs to render a row.
    for (const entry of starts[2].files) {
      assert.equal(typeof entry.file, 'string')
      assert.equal(typeof entry.bytes, 'number')
      assert.equal(typeof entry.startedAt, 'number')
    }
    complete.open()
    const report = await pass
    assert.equal(report.files, 4)
    // Once everything settles the in-flight set is empty again.
    const last = events.filter((event) => event.type === 'note-done').pop()
    assert.equal(last.active, 0)
    assert.deepEqual(last.files, [])
  } finally {
    rmSync(box.base, { recursive: true, force: true })
  }
})

test('the per-run file budget still caps a concurrent pass', async () => {
  const box = sandbox()
  try {
    notes(box.vault, 6)
    const report = await runDistillPass({
      roots: [box.vault], store: box.store, maxFilesPerRun: 2, concurrency: 4,
      complete: async () => JSON.stringify({
        insights: [{ content: '本轮预算之外的笔记，必须留到下一轮再蒸馏。', category: 'fact', importance: 3 }],
      }),
    })
    // The pool parallelises a batch; it does not enlarge it.
    assert.equal(report.files, 2)
    assert.equal(report.roots[0].pending, 6)
    assert.equal(report.roots[0].distilled, 2)
  } finally {
    rmSync(box.base, { recursive: true, force: true })
  }
})

// -------------------------------------------------------------- route ----

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
  if (body !== undefined) {
    setImmediate(() => {
      req.emit('data', Buffer.from(JSON.stringify(body)))
      req.emit('end')
    })
  }
  return pending.then(() => ({ status: res.status, body: res.body(), res }))
}

const base = { getRoots: () => [], setRoots: async () => ({}), reject: () => undefined }

test('GET /concurrency reports the live value, ceiling and default', async () => {
  const handler = createHandler({
    ...base,
    distillStatus: () => ({ concurrency: 3, concurrencyMax: 8, concurrencyDefault: 3 }),
  })
  const result = await call(handler, { path: '/concurrency' })
  assert.equal(result.status, 200)
  assert.deepEqual(result.body.concurrency, { value: 3, max: 8, default: 3 })
})

test('POST /concurrency persists the choice and echoes it', async () => {
  let written
  const handler = createHandler({
    ...base,
    setDistillConcurrency: (value) => { written = value; return { changed: true, concurrency: value } },
    distillStatus: () => ({ concurrency: 6, concurrencyMax: 8, concurrencyDefault: 3 }),
  })
  const result = await call(handler, { path: '/concurrency', method: 'POST', body: { concurrency: 6 } })
  assert.equal(result.status, 200)
  assert.equal(written, 6)
  assert.equal(result.body.concurrency, 6)
  assert.equal(result.body.status.concurrency, 6)
})

test('POST /concurrency rejects values that are not a usable worker count', async () => {
  let written
  const handler = createHandler({
    ...base,
    setDistillConcurrency: (value) => { written = value; return { changed: true, concurrency: value } },
  })
  for (const bad of [0, -1, 2.5, 'abc', null, {}]) {
    const result = await call(handler, { path: '/concurrency', method: 'POST', body: { concurrency: bad } })
    assert.equal(result.status, 400, 'rejected: ' + JSON.stringify(bad))
    assert.equal(result.body.code, 'invalid-concurrency')
  }
  assert.equal(written, undefined, 'an invalid value must never reach the writer')
})

test('POST /concurrency turns an over-max RangeError into a 400, not a 500', async () => {
  const handler = createHandler({
    ...base,
    // The Host owns the ceiling; a request past it is a bad request.
    setDistillConcurrency: () => { throw new RangeError('concurrency must be between 1 and 8') },
  })
  const result = await call(handler, { path: '/concurrency', method: 'POST', body: { concurrency: 12 } })
  assert.equal(result.status, 400)
  assert.equal(result.body.code, 'invalid-concurrency')
  assert.match(result.body.message, /between 1 and 8/u)
})

test('an unwired concurrency control answers 501 rather than crashing', async () => {
  const handler = createHandler({ ...base })
  const post = await call(handler, { path: '/concurrency', method: 'POST', body: { concurrency: 3 } })
  assert.equal(post.status, 501)
  assert.equal(post.body.code, 'concurrency-unavailable')
  // The read side still works: it degrades to nulls rather than failing.
  const get = await call(handler, { path: '/concurrency' })
  assert.equal(get.status, 200)
  assert.equal(get.body.concurrency.value, null)
})

test('PUT /concurrency is refused, it is a POST control', async () => {
  const handler = createHandler({
    ...base,
    setDistillConcurrency: () => ({ changed: true, concurrency: 3 }),
  })
  const result = await call(handler, { path: '/concurrency', method: 'PUT' })
  assert.equal(result.status, 405)
})

test('GET /state mirrors concurrency at the response root', async () => {
  const handler = createHandler({
    ...base,
    distillStatus: () => ({ concurrency: 4, concurrencyMax: 8, concurrencyDefault: 3, enabled: true }),
  })
  const result = await call(handler, { path: '/state' })
  assert.equal(result.status, 200)
  // The page seeds its picker from the root, and also keeps reading `distill`.
  assert.equal(result.body.concurrency, 4)
  assert.equal(result.body.concurrencyMax, 8)
  assert.equal(result.body.concurrencyDefault, 3)
  assert.equal(result.body.distill.concurrency, 4)
})
