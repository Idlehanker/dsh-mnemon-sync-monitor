import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  DocumentsStore, makeDescription, renderDocument, stripFrontmatter, sha256, slug,
} from '../lib/store.js'
import { collectMarkdown, planSync, readSource, resolveStoreDirectory } from '../lib/index.js'

/** Create an isolated workspace with a source root and a store. */
function workspace() {
  const base = mkdtempSync(join(tmpdir(), 'mnemon-sync-'))
  const source = join(base, 'kb')
  const store = join(base, 'store')
  mkdirSync(source, { recursive: true })
  mkdirSync(store, { recursive: true })
  return { base, source, store }
}

/** Write a Markdown file of a given size under a root. */
function writeSource(root, name, body) {
  const absolute = join(root, name)
  mkdirSync(join(absolute, '..'), { recursive: true })
  writeFileSync(absolute, body, 'utf8')
  return absolute
}

const LONG = '这是一段足够长的正文内容，用于通过最小字节数检查。'.repeat(12)

test('slug produces filename-safe text', () => {
  assert.equal(slug('Hello World'), 'hello-world')
  assert.equal(slug('!!!'), 'document')
  assert.equal(slug('A'.repeat(80)).length, 48)
})

test('stripFrontmatter removes an existing YAML block', () => {
  const raw = '---\ntitle: x\n---\n\nbody text'
  assert.equal(stripFrontmatter(raw).trim(), 'body text')
  assert.equal(stripFrontmatter('no frontmatter'), 'no frontmatter')
})

test('renderDocument round-trips through stripFrontmatter', () => {
  const record = {
    id: 'abc', title: 'T', description: 'D', status: 'active',
    createdAt: 'now', updatedAt: 'now', contentHash: 'h',
    sourcePaths: ['a/b.md'], sessionIds: [], memoryBodyIds: [],
  }
  const rendered = renderDocument(record, 'body')
  assert.ok(rendered.startsWith('---\n'))
  assert.equal(stripFrontmatter(rendered).trim(), 'body')
  assert.match(rendered, /source_paths:\n {2}- "a\/b\.md"/u)
})

test('makeDescription prefers headings and stays within 600 chars', () => {
  const body = '# Title\n\n## Section One\n\n' + LONG + '\n\n## Section Two\n'
  const description = makeDescription('dir/note.md', body)
  assert.ok(description.length <= 600)
  assert.ok(description.includes('Section One'))
  assert.ok(description.includes('dir'))
})

test('collectMarkdown skips excluded directories', () => {
  const { source } = workspace()
  writeSource(source, 'a.md', LONG)
  writeSource(source, 'sub/b.md', LONG)
  writeSource(source, '.git/c.md', LONG)
  writeSource(source, 'node_modules/d.md', LONG)
  writeSource(source, 'e.txt', LONG)
  const found = collectMarkdown(source)
  assert.equal(found.length, 2)
})

test('readSource ignores files below the minimum size', () => {
  const { source } = workspace()
  const small = writeSource(source, 'small.md', 'tiny')
  const big = writeSource(source, 'big.md', LONG)
  assert.equal(readSource(small, 200), undefined)
  assert.ok(readSource(big, 200) !== undefined)
})

test('planSync creates, updates, and archives', () => {
  const { source, store } = workspace()
  writeSource(source, 'keep.md', LONG)
  writeSource(source, 'edit.md', LONG)
  const documents = new DocumentsStore(store)

  const first = planSync({ root: source, index: documents.readIndex(), minBytes: 10, prune: false })
  assert.equal(first.create.length, 2)
  documents.apply(first)

  writeSource(source, 'edit.md', LONG + ' changed')
  const second = planSync({ root: source, index: documents.readIndex(), minBytes: 10, prune: false })
  assert.equal(second.create.length, 0)
  assert.equal(second.update.length, 1)
  assert.equal(second.update[0].record.revision, 2)
  documents.apply(second)

  rmSync(join(source, 'keep.md'))
  const third = planSync({ root: source, index: documents.readIndex(), minBytes: 10, prune: true })
  assert.equal(third.archive.length, 1)
  const counts = documents.apply(third)
  assert.equal(counts.archived, 1)

  const index = documents.readIndex()
  const archived = index.documents.find((document) => document.status === 'archived')
  assert.ok(archived !== undefined)
  assert.ok(existsSync(join(store, 'archived', archived.filename)))
})

test('planSync leaves other roots untouched when pruning', () => {
  const { source, store } = workspace()
  const other = join(source, '..', 'other-kb')
  mkdirSync(other, { recursive: true })
  writeSource(source, 'mine.md', LONG)
  writeSource(other, 'theirs.md', LONG)
  const documents = new DocumentsStore(store)
  documents.apply(planSync({ root: source, index: documents.readIndex(), minBytes: 10, prune: false }))
  documents.apply(planSync({ root: other, index: documents.readIndex(), minBytes: 10, prune: false }))
  assert.equal(documents.readIndex().documents.length, 2)

  const plan = planSync({ root: source, index: documents.readIndex(), minBytes: 10, prune: true })
  assert.equal(plan.archive.length, 0)
})

test('store enforces the active capacity ceiling', () => {
  const { source, store } = workspace()
  for (let index = 0; index < 4; index += 1) writeSource(source, 'n' + index + '.md', LONG)
  const documents = new DocumentsStore(store)
  const plan = planSync({ root: source, index: documents.readIndex(), minBytes: 10, prune: false })
  const counts = documents.apply(plan, { limitBytes: 1200 })
  assert.ok(counts.skipped > 0)
  assert.ok(counts.created < 4)
})

test('resolveStoreDirectory honours configuration', () => {
  const { store } = workspace()
  assert.equal(resolveStoreDirectory(store), store)
  assert.ok(resolveStoreDirectory(undefined).endsWith(join('.mnemon', 'documents')))
})

test('index content hash matches the stored body', () => {
  const { source, store } = workspace()
  writeSource(source, 'hash.md', LONG)
  const documents = new DocumentsStore(store)
  documents.apply(planSync({ root: source, index: documents.readIndex(), minBytes: 10, prune: false }))
  const record = documents.readIndex().documents[0]
  const file = readFileSync(join(store, 'active', record.filename), 'utf8')
  assert.equal(sha256(stripFrontmatter(file).trim()), record.contentHash)
})
