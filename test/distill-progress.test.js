import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runDistillPass } from '../lib/distill.js'

/** One throwaway vault plus an empty store, cleaned up by the caller. */
function sandbox() {
  const base = mkdtempSync(join(tmpdir(), 'dsh-distill-events-'))
  const vault = join(base, 'vault')
  const store = join(base, 'store')
  mkdirSync(vault, { recursive: true })
  mkdirSync(store, { recursive: true })
  return { base, vault, store }
}

function note(vault, name, body) {
  writeFileSync(join(vault, name), body, 'utf8')
}

/** A model double: one insight per call, no network. */
function fakeComplete() {
  const calls = []
  const fn = async () => {
    calls.push(1)
    return JSON.stringify({
      insights: [{
        content: '这是第 ' + calls.length + ' 条自洽的可长期保存的结论，长度超过最小阈值。',
        category: 'fact', importance: 3, tags: [], entities: [],
      }],
    })
  }
  fn.calls = calls
  return fn
}

test('the pass reports one event per note, in order, with the file name', async () => {
  const box = sandbox()
  try {
    note(box.vault, 'a.md', '# A\n\n' + '甲'.repeat(80))
    note(box.vault, 'b.md', '# B\n\n' + '乙'.repeat(80))
    const events = []
    const report = await runDistillPass({
      roots: [box.vault],
      store: box.store,
      complete: fakeComplete(),
      maxFilesPerRun: 10,
      maxInsightsPerFile: 2,
      onEvent: (event) => events.push(event),
    })

    assert.equal(report.files, 2)
    const kinds = events.map((e) => e.type)
    assert.deepEqual(kinds, ['root', 'note-start', 'note-done', 'note-start', 'note-done'])
    assert.equal(events[0].batch, 2)
    assert.equal(events[1].file, 'a.md')
    assert.equal(events[2].file, 'a.md')
    assert.equal(events[2].proposed, 1)
    assert.equal(events[3].file, 'b.md')
  } finally {
    rmSync(box.base, { recursive: true, force: true })
  }
})

test('note-start is published BEFORE the model call, so a page can name the file in flight', async () => {
  const box = sandbox()
  try {
    note(box.vault, 'slow.md', '# Slow\n\n' + '丙'.repeat(80))
    const order = []
    await runDistillPass({
      roots: [box.vault],
      store: box.store,
      complete: async () => {
        order.push('model')
        return JSON.stringify({ insights: [{ content: '一条足够长、能够独立成立的结论内容。', category: 'fact', importance: 3 }] })
      },
      onEvent: (event) => order.push(event.type),
    })
    assert.deepEqual(order, ['root', 'note-start', 'model', 'note-done'])
  } finally {
    rmSync(box.base, { recursive: true, force: true })
  }
})

test('a failing model call publishes note-failed and leaves the note pending', async () => {
  const box = sandbox()
  try {
    note(box.vault, 'bad.md', '# Bad\n\n' + '丁'.repeat(80))
    const events = []
    const report = await runDistillPass({
      roots: [box.vault],
      store: box.store,
      complete: async () => { throw new Error('gateway down') },
      onEvent: (event) => events.push(event),
    })
    assert.equal(report.errors.length, 1)
    const failed = events.find((e) => e.type === 'note-failed')
    assert.ok(failed !== undefined)
    assert.equal(failed.file, 'bad.md')
    assert.match(failed.error, /gateway down/)
    // Retryable: the note must still be pending on the next pass.
    const second = await runDistillPass({
      roots: [box.vault],
      store: box.store,
      complete: async () => { throw new Error('still down') },
      onEvent: () => {},
    })
    assert.equal(second.roots[0].pending, 1)
  } finally {
    rmSync(box.base, { recursive: true, force: true })
  }
})

test('a throwing observer cannot abort the pass', async () => {
  const box = sandbox()
  try {
    note(box.vault, 'obs.md', '# Obs\n\n' + '戊'.repeat(80))
    const report = await runDistillPass({
      roots: [box.vault],
      store: box.store,
      complete: async () => JSON.stringify({ insights: [{ content: '观察者抛错时，这条结论仍然必须被写入。', category: 'fact', importance: 3 }] }),
      onEvent: () => { throw new Error('observer exploded') },
    })
    assert.equal(report.files, 1)
    assert.equal(report.proposed, 1)
  } finally {
    rmSync(box.base, { recursive: true, force: true })
  }
})

test('a pass with nothing pending publishes no note events at all', async () => {
  const box = sandbox()
  try {
    note(box.vault, 'done.md', '# Done\n\n' + '己'.repeat(80))
    await runDistillPass({ roots: [box.vault], store: box.store, complete: fakeComplete(), onEvent: () => {} })
    const events = []
    await runDistillPass({ roots: [box.vault], store: box.store, complete: fakeComplete(), onEvent: (e) => events.push(e) })
    // Idempotent: the ledger already has the hash, so nothing is emitted and no
    // model call is spent. This is what stops an idle queue from spinning.
    assert.deepEqual(events, [])
  } finally {
    rmSync(box.base, { recursive: true, force: true })
  }
})
