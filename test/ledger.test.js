import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DistillLedger, contentHashOf, cleanBody, computeCoverage, runDistillPass } from '../lib/distill.js'

/** A vault with one note of real prose. */
function makeVault(note) {
  const base = mkdtempSync(join(tmpdir(), 'ledger-'))
  mkdirSync(join(base, 'notes'), { recursive: true })
  writeFileSync(join(base, 'notes', 'a.md'), note, 'utf8')
  return base
}

const PROSE = [
  '---',
  'title: A note',
  'tags:',
  '  - x',
  '---',
  '',
  '# Heading',
  '',
  'This paragraph is long enough to be worth distilling because it carries a claim.',
  'Another line to push the body past the minimum length threshold used by the pass.',
  '',
].join('\n')

const REPLY = { insights: [{ content: 'a distilled claim', category: 'fact', importance: 3, tags: [], entities: [] }] }

// ------------------------------------------------------------ content hash

test('contentHashOf ignores trailing whitespace differences', () => {
  assert.equal(contentHashOf('same text'), contentHashOf('same text   '))
  assert.equal(contentHashOf('a\r\nb'), contentHashOf('a\nb'))
})

test('contentHashOf changes when the content changes', () => {
  assert.notEqual(contentHashOf('one'), contentHashOf('two'))
})

// ----------------------------------------------------------- CRLF handling

test('cleanBody strips frontmatter from a CRLF note', () => {
  const crlf = PROSE.replace(/\n/g, '\r\n')
  const out = cleanBody(crlf)
  assert.ok(!out.includes('title: A note'), 'frontmatter must be gone')
  assert.ok(out.includes('This paragraph'))
})

test('cleanBody drops fenced code blocks', () => {
  const withCode = PROSE + '```dataview\nTABLE file.name\n```\n'
  const out = cleanBody(withCode)
  assert.ok(!out.includes('dataview'))
  assert.ok(out.includes('This paragraph'))
})

// ----------------------------------------------------------------- ledger

test('DistillLedger round-trips an entry', () => {
  const base = mkdtempSync(join(tmpdir(), 'ledger-'))
  const ledger = new DistillLedger(base)
  const root = join(base, 'vault')
  ledger.mark(root, 'abc123', { rel: 'a.md', insights: ['id-1'], distilled: 1, at: 'now' })
  assert.equal(ledger.save(root), true)
  const reloaded = new DistillLedger(base).load(root)
  assert.equal(reloaded.entries['abc123'].insights[0], 'id-1')
})

test('DistillLedger prune removes entries whose content vanished', () => {
  const base = mkdtempSync(join(tmpdir(), 'ledger-'))
  const ledger = new DistillLedger(base)
  const root = join(base, 'vault')
  ledger.mark(root, 'keep', { rel: 'a.md', insights: [], distilled: 0, at: 'now' })
  ledger.mark(root, 'drop', { rel: 'gone.md', insights: [], distilled: 0, at: 'now' })
  assert.equal(ledger.prune(root, new Set(['keep'])), 1)
  assert.equal(Object.keys(ledger.load(root).entries).length, 1)
})

test('DistillLedger treats a v1 watermark file as an empty ledger', () => {
  const base = mkdtempSync(join(tmpdir(), 'ledger-'))
  const ledger = new DistillLedger(base)
  const root = join(base, 'vault')
  mkdirSync(join(base, '.distill'), { recursive: true })
  writeFileSync(ledger.pathFor(root), JSON.stringify({ commit: 'abc', highWaterMs: 123 }), 'utf8')
  const fresh = new DistillLedger(base).load(root)
  assert.deepEqual(fresh.entries, {})
})

// ---------------------------------------------------------------- coverage

test('computeCoverage reports every note as pending when the ledger is empty', () => {
  const vault = makeVault(PROSE)
  const store = mkdtempSync(join(tmpdir(), 'store-'))
  const c = computeCoverage({ roots: [vault], store })
  assert.equal(c.scanned, 1)
  assert.equal(c.distilled, 0)
  assert.equal(c.pending, 1)
  rmSync(vault, { recursive: true, force: true })
})

test('computeCoverage counts a note as distilled once the ledger knows its hash', () => {
  const vault = makeVault(PROSE)
  const store = mkdtempSync(join(tmpdir(), 'store-'))
  const hash = contentHashOf(cleanBody(PROSE))
  const ledger = new DistillLedger(store)
  ledger.mark(vault, hash, { rel: 'notes/a.md', insights: ['x'], distilled: 1, at: 'now' })
  ledger.save(vault)
  const c = computeCoverage({ roots: [vault], store })
  assert.equal(c.distilled, 1)
  assert.equal(c.pending, 0)
  rmSync(vault, { recursive: true, force: true })
})

test('computeCoverage reports an edited note as pending again', () => {
  const vault = makeVault(PROSE)
  const store = mkdtempSync(join(tmpdir(), 'store-'))
  const hash = contentHashOf(cleanBody(PROSE))
  const ledger = new DistillLedger(store)
  ledger.mark(vault, hash, { rel: 'notes/a.md', insights: ['x'], distilled: 1, at: 'now' })
  ledger.save(vault)
  writeFileSync(join(vault, 'notes', 'a.md'), PROSE + '\nA new line changes the content.\n', 'utf8')
  const c = computeCoverage({ roots: [vault], store })
  assert.equal(c.pending, 1)
  assert.equal(c.distilled, 0)
  rmSync(vault, { recursive: true, force: true })
})

// -------------------------------------------------------------------- pass

test('runDistillPass distils pending notes and records them in the ledger', async () => {
  const vault = makeVault(PROSE)
  const store = mkdtempSync(join(tmpdir(), 'store-'))
  const persisted = []
  const report = await runDistillPass({
    roots: [vault],
    store,
    complete: async () => JSON.stringify(REPLY),
    maxFilesPerRun: 5,
    maxInsightsPerFile: 2,
    persistInsight: async (insight) => { persisted.push(insight.content); return ['insight-id-1'] },
  })
  assert.equal(report.files, 1)
  assert.equal(report.proposed, 1)
  assert.equal(report.persisted, 1)
  assert.equal(report.errors.length, 0)
  assert.deepEqual(persisted, ['a distilled claim'])
  const ledger = new DistillLedger(store)
  const hash = contentHashOf(cleanBody(PROSE))
  assert.equal(ledger.load(vault).entries[hash].insights[0], 'insight-id-1')
  rmSync(vault, { recursive: true, force: true })
})

test('runDistillPass is idempotent: a second pass skips what is already distilled', async () => {
  const vault = makeVault(PROSE)
  const store = mkdtempSync(join(tmpdir(), 'store-'))
  const options = {
    roots: [vault], store,
    complete: async () => JSON.stringify(REPLY),
    maxFilesPerRun: 5, maxInsightsPerFile: 2,
    persistInsight: async () => ['insight-id-1'],
  }
  await runDistillPass(options)
  const second = await runDistillPass(options)
  assert.equal(second.files, 0, 'nothing should be distilled twice')
  assert.equal(second.alreadyDone, 1)
  rmSync(vault, { recursive: true, force: true })
})

test('a failed note stays pending so the next pass retries it', async () => {
  const vault = makeVault(PROSE)
  const store = mkdtempSync(join(tmpdir(), 'store-'))
  const options = {
    roots: [vault], store,
    complete: async () => { throw new Error('model unavailable') },
    maxFilesPerRun: 5,
    persistInsight: async () => ['x'],
  }
  const report = await runDistillPass(options)
  assert.equal(report.errors.length, 1)
  const ledger = new DistillLedger(store)
  assert.equal(Object.keys(ledger.load(vault).entries).length, 0, 'a failure must not record success')
  rmSync(vault, { recursive: true, force: true })
})
