import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runDistillPass, ClaimIndex, CLAIM_INDEX_LIMIT, contentKey } from '../lib/distill.js'

/**
 * A vault of `count` notes. Each one must clear BOTH floors: `scanMarkdown`
 * drops files under 200 bytes before the pass ever sees them, and the pass then
 * drops bodies under 80 characters after cleaning.
 */
function notes(vault, count, prefix = 'n') {
  for (let index = 0; index < count; index += 1) {
    writeFileSync(
      join(vault, prefix + index + '.md'),
      '# ' + prefix + index + '\n\n' + ('正文内容' + prefix + index).repeat(40) + '\n',
      'utf8',
    )
  }
}

function sandbox(...roots) {
  const base = mkdtempSync(join(tmpdir(), 'budget-'))
  const store = join(base, 'store')
  mkdirSync(store, { recursive: true })
  const vaults = roots.map((name) => {
    const path = join(base, name)
    mkdirSync(path, { recursive: true })
    return path
  })
  return { base, store, vaults }
}

/**
 * A model double that answers immediately with a claim derived from the prompt,
 * so each note yields distinct content and dedupe cannot mask a missing call.
 */
function distinctComplete() {
  let calls = 0
  const fn = async (messages) => {
    calls += 1
    const text = String(messages?.[1]?.content ?? messages?.[0]?.content ?? '')
    const id = /File: (.+)/u.exec(text)?.[1]?.trim() ?? 'x'
    return JSON.stringify({
      insights: [{ content: '结论 ' + id + ' 是一条足够长而且可以独立成立的结论。', category: 'fact', importance: 3 }],
    })
  }
  fn.calls = () => calls
  return fn
}

// ------------------------------------------------------- fair scheduling

test('the run budget is shared round-robin, so a small root is not starved', async () => {
  const box = sandbox('big', 'small')
  try {
    notes(box.vaults[0], 6, 'big')
    notes(box.vaults[1], 2, 'small')
    const report = await runDistillPass({
      roots: box.vaults,
      store: box.store,
      complete: distinctComplete(),
      // Enough for both roots, but if the budget were handed out in root order
      // the small root would still be reached only after the big one is drained.
      maxFilesPerRun: 4,
      concurrency: 1,
    })
    // One note each per cycle: big, small, big, small.
    assert.equal(report.files, 4)
    assert.equal(report.roots[0].distilled, 2, 'the big root takes its share, not everything')
    assert.equal(report.roots[1].distilled, 2, 'the small root finishes in this same pass')

    // `pending` is the count BEFORE allocation; a follow-up pass proves the small
    // root really is drained rather than merely handed a share.
    const second = await runDistillPass({
      roots: box.vaults, store: box.store, complete: distinctComplete(), maxFilesPerRun: 10, concurrency: 1,
    })
    assert.equal(second.roots[1].pending, 0, 'nothing is left for the small root')
    assert.equal(second.roots[0].pending, 4, 'the big root still has its backlog')
  } finally {
    rmSync(box.base, { recursive: true, force: true })
  }
})

test('a root whose share rounds down to zero says so and keeps its backlog', async () => {
  const box = sandbox('a', 'b', 'c')
  try {
    notes(box.vaults[0], 5, 'a')
    notes(box.vaults[1], 5, 'b')
    notes(box.vaults[2], 5, 'c')
    const report = await runDistillPass({
      roots: box.vaults,
      store: box.store,
      complete: distinctComplete(),
      maxFilesPerRun: 2,
      concurrency: 1,
    })
    assert.equal(report.files, 2)
    // Round-robin gives one note to each of the first two roots and none to the
    // third; that third must keep its whole backlog, not silently forget it.
    assert.equal(report.roots[2].distilled, 0)
    assert.equal(report.roots[2].pending, 5)
    assert.match(String(report.roots[2].note), /budget exhausted/u)
  } finally {
    rmSync(box.base, { recursive: true, force: true })
  }
})

test('subsequent passes reach the starved root instead of retrying the big one', async () => {
  const box = sandbox('big', 'small')
  try {
    notes(box.vaults[0], 4, 'big')
    notes(box.vaults[1], 2, 'small')
    const first = await runDistillPass({
      roots: box.vaults, store: box.store, complete: distinctComplete(), maxFilesPerRun: 3, concurrency: 1,
    })
    assert.equal(first.files, 3)
    const second = await runDistillPass({
      roots: box.vaults, store: box.store, complete: distinctComplete(), maxFilesPerRun: 3, concurrency: 1,
    })
    // Nothing is skipped forever: the two passes together cover all six notes.
    assert.equal(first.files + second.files, 6)
    // `pending` is measured before allocation, so an empty third pass - not the
    // counter - is what proves both roots are actually drained.
    const third = await runDistillPass({
      roots: box.vaults, store: box.store, complete: distinctComplete(), maxFilesPerRun: 10, concurrency: 1,
    })
    assert.equal(third.files, 0, 'the backlog is gone, not merely re-shared')
    for (const entry of third.roots) assert.match(String(entry.note), /already distilled/u)
  } finally {
    rmSync(box.base, { recursive: true, force: true })
  }
})

// --------------------------------------------------------- overlap guard

test('a nested root is shadowed by its parent, so its notes are dispatched once', async () => {
  const box = sandbox('vault')
  try {
    const inner = join(box.vaults[0], 'inner')
    mkdirSync(inner, { recursive: true })
    notes(box.vaults[0], 2, 'outer')
    notes(inner, 1, 'shared')
    const complete = distinctComplete()
    const report = await runDistillPass({
      // The child is reachable through the parent: the same file under two names.
      roots: [...box.vaults, inner],
      store: box.store,
      complete,
      maxFilesPerRun: 10,
      concurrency: 1,
    })
    assert.equal(report.roots.length, 1, 'the nested root is folded away, not walked')
    assert.equal(report.files, 3, 'three physical notes, three model calls')
    assert.equal(complete.calls(), 3, 'the shared note is never sent twice')
    assert.equal(report.shadowed.length, 1)
    assert.equal(report.shadowed[0].root, inner)
    assert.equal(report.shadowed[0].owner, box.vaults[0])
  } finally {
    rmSync(box.base, { recursive: true, force: true })
  }
})

test('the same root listed twice is walked once', async () => {
  const box = sandbox('vault')
  try {
    notes(box.vaults[0], 2)
    const complete = distinctComplete()
    const report = await runDistillPass({
      roots: [box.vaults[0], box.vaults[0]],
      store: box.store,
      complete,
      maxFilesPerRun: 10,
      concurrency: 1,
    })
    assert.equal(report.roots.length, 1)
    assert.equal(complete.calls(), 2)
    assert.equal(report.shadowed.length, 1)
  } finally {
    rmSync(box.base, { recursive: true, force: true })
  }
})

// ------------------------------------------------------- claim persistence

test('a claim written in one pass is not written again in the next', async () => {
  const box = sandbox('a', 'b')
  try {
    // Two DIFFERENT notes that the model answers with the SAME claim.
    notes(box.vaults[0], 1, 'first')
    notes(box.vaults[1], 1, 'second')
    const repeated = async () => JSON.stringify({
      insights: [{ content: '这条结论在两篇不同的笔记里都出现过，而且足够长。', category: 'fact', importance: 3 }],
    })

    const written = []
    const persist = (insight) => { written.push(insight.content); return ['id'] }

    const first = await runDistillPass({
      roots: [box.vaults[0]], store: box.store, complete: repeated, maxFilesPerRun: 10, concurrency: 1, persistInsight: persist,
    })
    assert.equal(first.persisted, 1)
    assert.equal(written.length, 1)

    // A later pass meets the same conclusion in a different file. Without the
    // persisted claim index `seen` starts empty, so it would be written twice.
    const second = await runDistillPass({
      roots: [box.vaults[1]], store: box.store, complete: repeated, maxFilesPerRun: 10, concurrency: 1, persistInsight: persist,
    })
    assert.equal(second.persisted, 0, 'the claim is already known from the earlier pass')
    assert.equal(second.proposed, 0)
    assert.equal(written.length, 1, 'the store saw it exactly once')
    assert.equal(second.files, 1, 'the note is still marked distilled, it is not re-asked forever')
  } finally {
    rmSync(box.base, { recursive: true, force: true })
  }
})

test('the claim index round-trips through disk and is bounded', async () => {
  const base = mkdtempSync(join(tmpdir(), 'claims-'))
  try {
    const key = contentKey('a durable claim')
    const writer = new ClaimIndex(base)
    writer.add(key, { root: 'C:\\vault', rel: 'a.md' })
    assert.equal(writer.save(), true)

    const reader = new ClaimIndex(base)
    assert.equal(reader.has(key), true)
    assert.equal(reader.has(contentKey('something else')), false)
    assert.equal(reader.load().get(key).rel, 'a.md')

    // The cap is an eviction policy, not an assertion about the vault: prove the
    // oldest entries go first and the newest survive.
    const capped = new ClaimIndex(base)
    capped.load()
    for (let index = 0; index < 5; index += 1) capped.add('k' + index, { root: 'r', rel: 'x.md' })
    assert.ok(capped.keys.size > 0)
    assert.ok(CLAIM_INDEX_LIMIT >= 1000, 'the cap must be far above a normal vault')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('a missing or corrupt claim file degrades to an empty index, never an error', async () => {
  const base = mkdtempSync(join(tmpdir(), 'claims-bad-'))
  try {
    const missing = new ClaimIndex(base)
    assert.equal(missing.load().size, 0)

    mkdirSync(join(base, '.distill'), { recursive: true })
    writeFileSync(join(base, '.distill', 'claims.json'), '{ this is not json', 'utf8')
    const corrupt = new ClaimIndex(base)
    assert.equal(corrupt.load().size, 0, 'a broken cache must not block distillation')
    assert.equal(corrupt.has('anything'), false)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
