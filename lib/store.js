/**
 * Project Documents store adapter.
 *
 * Writes into the same on-disk layout that dsh-mnemon-source-documents owns:
 *   <store>/index.json, <store>/active/<file>.md, <store>/archived/<file>.md
 * This module mirrors that Source's lock protocol exactly so a running Host and
 * this watcher never corrupt the index.
 *
 * @module dsh-mnemon-sync-monitor/store
 */
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

/** Lock acquisition timeout, matching the Documents Source. */
const LOCK_TIMEOUT_MS = 5_000
/** Poll interval between lock attempts. */
const LOCK_RETRY_MS = 20
/** A lock older than this was left by a dead process. */
const LOCK_STALE_MS = 30_000
/** Default active-document capacity: 32 MiB. */
export const DEFAULT_LIMIT_BYTES = 33_554_432
/** Hard ceiling for a single document, matching the Source. */
const MAX_DOC_BYTES = 2_097_152

/** Synchronous sleep; the lock loop is synchronous by contract. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** SHA-256 hex digest, the hash function the Documents Source uses. */
export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

/** Filename-safe slug derived from a title. */
export function slug(title) {
  return title.normalize('NFKD').toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '')
    .slice(0, 48) || 'document'
}

/** YAML scalar quoting used by the Documents frontmatter. */
function yamlString(value) {
  return JSON.stringify(value)
}

/**
 * Render a document body with the frontmatter the Source parses back.
 * @param {object} record Index record.
 * @param {string} content Markdown body.
 * @returns {string} Full file text.
 */
export function renderDocument(record, content) {
  const list = (items) => items.length === 0
    ? '  []'
    : items.map((item) => '  - ' + yamlString(item)).join('\n')
  return '---\n'
    + 'id: ' + yamlString(record.id) + '\n'
    + 'title: ' + yamlString(record.title) + '\n'
    + 'description: ' + yamlString(record.description) + '\n'
    + 'status: ' + yamlString(record.status) + '\n'
    + 'created_at: ' + yamlString(record.createdAt) + '\n'
    + 'updated_at: ' + yamlString(record.updatedAt) + '\n'
    + 'content_hash: ' + yamlString(record.contentHash) + '\n'
    + 'source_paths:\n' + list(record.sourcePaths) + '\n'
    + 'session_ids:\n' + list(record.sessionIds) + '\n'
    + 'memory_body_ids:\n' + list(record.memoryBodyIds) + '\n'
    + '---\n\n' + content.trim() + '\n'
}

/** Strip an existing YAML frontmatter block from source Markdown. */
export function stripFrontmatter(raw) {
  // A leading UTF-8 BOM defeats every ^ anchor below and would leave the YAML in the
  // body — the same poisoning class as the CRLF delimiter bug. Drop it first.
  const text = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw
  // A YAML block delimiter may end with LF or CRLF. Matching only '---\n' meant an
  // Obsidian vault saved with Windows line endings kept its ENTIRE frontmatter,
  // which was then written into the document body as prose: 277 of 352 records in
  // one vault carried a duplicated `title:`/`tags:` block, polluting search text
  // and defeating the body-level dedupe (identical notes hashed differently).
  const open = /^---\r?\n/u.exec(text)
  if (open === null) return raw
  const rest = text.slice(open[0].length)
  // The closing fence may sit at offset 0 (empty frontmatter) or after a newline.
  const close = /^---[ \t]*(?:\r?\n|$)/u.exec(rest)
    ?? /\r?\n---[ \t]*(?:\r?\n|$)/u.exec(rest)
  if (close === null) return raw
  return rest.slice(close.index + close[0].length)
}

/**
 * Build a search-oriented description.
 *
 * Documents scores description hits at 7, above body hits at 4, so deriving a
 * description from headings and frequent terms raises recall more than longer
 * body text does.
 *
 * @param {string} relPath Source path relative to its root.
 * @param {string} body Markdown body.
 * @returns {string} Description of at most 600 characters.
 */
export function makeDescription(relPath, body) {
  const lines = body.split(/\r?\n/u)
  const heads = lines
    .filter((line) => /^#{1,3}\s+/u.test(line))
    .map((line) => line.replace(/^#+\s+/u, '').trim())
    .slice(0, 4)
  const paragraph = lines.find((line) => {
    const text = line.trim()
    return text !== '' && !text.startsWith('#') && !text.startsWith('>') && text.length >= 30
  }) ?? ''
  const words = body.match(/[\u4e00-\u9fa5]{2,6}/gu) ?? []
  const frequency = new Map()
  for (const word of words) frequency.set(word, (frequency.get(word) ?? 0) + 1)
  const keywords = [...frequency.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 10)
    .map(([word]) => word)
  const directory = relPath.includes('/') ? relPath.split('/')[0] : ''
  const parts = [
    directory === '' ? '' : '目录:' + directory,
    heads.join(' / '),
    paragraph.replace(/\s+/gu, ' ').slice(0, 120),
    keywords.join('、'),
  ].filter(Boolean)
  const description = parts.join(' | ').replace(/\s+/gu, ' ').trim()
  return description.length > 600 ? description.slice(0, 599) + '…' : description
}

/** Project Documents store bound to one directory. */
export class DocumentsStore {
  /** @param {string} directory Absolute store directory containing index.json. */
  constructor(directory) {
    this.directory = directory
    this.indexPath = join(directory, 'index.json')
    this.activeDirectory = join(directory, 'active')
    this.archivedDirectory = join(directory, 'archived')
    this.lockPath = join(directory, '.index.lock')
    mkdirSync(this.activeDirectory, { recursive: true })
    mkdirSync(this.archivedDirectory, { recursive: true })
  }

  /**
   * Run a callback while holding the index lock.
   * @template T
   * @param {() => T} callback Critical section body.
   * @returns {T} Callback result.
   */
  withLock(callback) {
    const deadline = Date.now() + LOCK_TIMEOUT_MS
    let descriptor
    while (descriptor === undefined) {
      try {
        descriptor = openSync(this.lockPath, 'wx', 0o600)
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
        try {
          if (Date.now() - statSync(this.lockPath).mtimeMs > LOCK_STALE_MS) {
            rmSync(this.lockPath, { force: true })
          }
        } catch (statError) {
          if (statError.code !== 'ENOENT') throw statError
        }
        if (Date.now() >= deadline) {
          throw new Error('timed out waiting for document lock: ' + this.lockPath)
        }
        sleepSync(LOCK_RETRY_MS)
      }
    }
    try {
      return callback()
    } finally {
      closeSync(descriptor)
      rmSync(this.lockPath, { force: true })
    }
  }

  /** Read the index, creating an empty one when absent. */
  readIndex() {
    if (!existsSync(this.indexPath)) return { version: 1, documents: [] }
    const raw = JSON.parse(readFileSync(this.indexPath, 'utf8'))
    if (raw === null || typeof raw !== 'object' || raw.version !== 1 || !Array.isArray(raw.documents)) {
      throw new Error('invalid document index: ' + this.indexPath)
    }
    return raw
  }

  /** Persist the index atomically, matching the Source's temp-and-rename. */
  writeIndex(index) {
    const temporary = this.indexPath + '.' + process.pid + '.' + randomUUID() + '.tmp'
    writeFileSync(temporary, JSON.stringify(index, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, this.indexPath)
  }

  /** Total bytes occupied by active documents. */
  static usedBytes(index) {
    return index.documents
      .filter((document) => document.status === 'active')
      .reduce((total, document) => total + document.sizeBytes, 0)
  }

  /**
   * Apply one sync plan atomically under the lock.
   *
   * @param {{create: object[], update: object[], archive: object[]}} plan Planned operations.
   * @param {{limitBytes?: number}} options Capacity ceiling.
   * @returns {{created: number, updated: number, archived: number, skipped: number}} Counts.
   */
  apply(plan, options = {}) {
    const limitBytes = options.limitBytes ?? DEFAULT_LIMIT_BYTES
    return this.withLock(() => {
      const index = this.readIndex()
      let used = DocumentsStore.usedBytes(index)
      const counts = { created: 0, updated: 0, archived: 0, skipped: 0 }

      for (const operation of plan.create) {
        const rendered = renderDocument(operation.record, operation.content)
        const sizeBytes = Buffer.byteLength(rendered, 'utf8')
        if (sizeBytes > MAX_DOC_BYTES || used + sizeBytes > limitBytes) { counts.skipped += 1; continue }
        operation.record.sizeBytes = sizeBytes
        writeFileSync(join(this.activeDirectory, operation.record.filename), rendered, 'utf8')
        index.documents.push(operation.record)
        used += sizeBytes
        counts.created += 1
      }

      for (const operation of plan.update) {
        const position = index.documents.findIndex((document) => document.id === operation.record.id)
        if (position < 0) { counts.skipped += 1; continue }
        const rendered = renderDocument(operation.record, operation.content)
        const sizeBytes = Buffer.byteLength(rendered, 'utf8')
        const delta = sizeBytes - index.documents[position].sizeBytes
        if (sizeBytes > MAX_DOC_BYTES || used + delta > limitBytes) { counts.skipped += 1; continue }
        operation.record.sizeBytes = sizeBytes
        writeFileSync(join(this.activeDirectory, operation.record.filename), rendered, 'utf8')
        index.documents[position] = operation.record
        used += delta
        counts.updated += 1
      }

      for (const record of plan.archive) {
        const position = index.documents.findIndex((document) => document.id === record.id)
        if (position < 0) { counts.skipped += 1; continue }
        const current = index.documents[position]
        if (current.status !== 'active') { counts.skipped += 1; continue }
        const source = join(this.activeDirectory, current.filename)
        const destination = join(this.archivedDirectory, current.filename)
        try { renameSync(source, destination) } catch (error) {
          if (error.code !== 'ENOENT') throw error
        }
        index.documents[position] = {
          ...current,
          status: 'archived',
          relativePath: 'documents/archived/' + current.filename,
          updatedAt: new Date().toISOString(),
          archivedAt: new Date().toISOString(),
          revision: current.revision + 1,
        }
        counts.archived += 1
      }

      if (counts.created + counts.updated + counts.archived > 0) this.writeIndex(index)
      return counts
    })
  }
}
