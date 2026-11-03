/**
 * dsh-mnemon-sync-monitor
 *
 * Watches one or more Markdown knowledge bases and keeps the dsh-mnemon
 * Project Documents store in sync in real time.
 *
 * The plugin owns no memory of its own: it is a file-system adapter that
 * writes into the Documents store using the same lock protocol the Documents
 * Source uses, so the running Host keeps reading a consistent index.
 *
 * @module dsh-mnemon-sync-monitor
 */
import { watch } from 'node:fs'
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, join, relative, basename, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  DocumentsStore, DEFAULT_LIMIT_BYTES, makeDescription, sha256,
  slug, stripFrontmatter,
} from './store.js'
import { ROUTE_PREFIX, createHandler, resolveProfilePatch } from './server.js'
import { readRoots, writeRoots } from './persist.js'

/** Cordis plugin name. */
export const name = 'dsh-mnemon-sync-monitor'

/**
 * Host services this plugin uses.
 *
 * Cordis declares dependencies as a flat array: the plugin's `apply` runs only
 * once every name here is available, so both must be declared. Each is still
 * checked at use time, because a profile can offer the service later; the
 * watcher runs whether or not the management route mounts.
 */
export const inject = ['webServer', 'connection']

/** Directories never scanned for Markdown. */
const EXCLUDE_SEGMENTS = new Set([
  '.git', '.trash', '.obsidian', 'node_modules', '.venv', 'dist', '.next', '.cache',
])

/** Longest Markdown body accepted; the import contract caps content in bytes. */
const MAX_CONTENT_BYTES = 1_000_000

/**
 * Resolve the Documents store directory.
 * @param {string|undefined} configured Explicit data directory from config.
 * @returns {string} Absolute store path.
 */
export function resolveStoreDirectory(configured) {
  if (configured !== undefined && configured.trim() !== '') return resolve(configured)
  return join(homedir(), '.mnemon', 'documents')
}

/**
 * Collect Markdown files under a root.
 * @param {string} root Absolute root directory.
 * @returns {string[]} Absolute file paths.
 */
export function collectMarkdown(root) {
  const found = []
  const pending = [root]
  while (pending.length > 0) {
    const directory = pending.pop()
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EACCES') continue
      throw error
    }
    for (const entry of entries) {
      if (EXCLUDE_SEGMENTS.has(entry.name)) continue
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) { pending.push(absolute); continue }
      if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') found.push(absolute)
    }
  }
  return found.sort()
}

/**
 * Normalize a source path for the index.
 * @param {string} root Source root.
 * @param {string} absolute Absolute file path.
 * @returns {string} Forward-slash relative path.
 */
function toRelative(root, absolute) {
  return relative(root, absolute).split(sep).join('/')
}

/** Separator that binds a record to the absolute root it was synced from. */
const ROOT_SEPARATOR = '\u0000'

/**
 * Compose an index source path that records its owning root.
 * @param {string} root Absolute source root.
 * @param {string} relativePath Root-relative path.
 * @returns {string} Encoded source path.
 */
export function makeSourcePath(root, relativePath) {
  return resolve(root) + ROOT_SEPARATOR + relativePath
}

/**
 * Split an encoded index source path.
 * @param {string} sourcePath Stored source path.
 * @returns {{ownerRoot: string|undefined, relativePath: string}} Decoded parts.
 */
export function splitSourcePath(sourcePath) {
  const index = sourcePath.indexOf(ROOT_SEPARATOR)
  const raw = index < 0
    ? { ownerRoot: undefined, relativePath: sourcePath }
    : {
        ownerRoot: sourcePath.slice(0, index),
        relativePath: sourcePath.slice(index + ROOT_SEPARATOR.length),
      }
  // Stores written on Windows keep backslashes; compare on one separator so a
  // record written by either tool matches the other.
  return { ownerRoot: raw.ownerRoot, relativePath: raw.relativePath.replace(/\\/gu, '/') }
}

/**
 * Read one source file into a body plus its content hash.
 * @param {string} absolute Absolute file path.
 * @param {number} minBytes Minimum accepted file size.
 * @returns {{body: string, hash: string} | undefined} Parsed file, or undefined when ignored.
 */
export function readSource(absolute, minBytes) {
  let raw
  try {
    raw = readFileSync(absolute, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
  if (Buffer.byteLength(raw, 'utf8') < minBytes) return undefined
  let body = stripFrontmatter(raw.replace(/\0/gu, '')).trim()
  if (body === '') return undefined
  if (Buffer.byteLength(body, 'utf8') > MAX_CONTENT_BYTES) {
    body = body.slice(0, MAX_CONTENT_BYTES)
  }
  return { body, hash: sha256(body) }
}

/**
 * Build the set of operations that reconcile one root with the index.
 *
 * @param {object} params Reconciliation inputs.
 * @param {string} params.root Absolute source root.
 * @param {object} params.index Documents index.
 * @param {number} params.minBytes Minimum file size.
 * @param {boolean} params.prune Archive records whose source disappeared.
 * @returns {{create: object[], update: object[], archive: object[]}} Plan.
 */
export function planSync({ root, index, minBytes, prune }) {
  const files = collectMarkdown(root)
  // Ownership resolution accepts two encodings so a store written by an older
  // tool keeps working:
  //   encoded  - sourcePaths[0] is `<absolute-root>\u0000<relative>`
  //   legacy   - sourcePaths[0] is a bare root-relative path
  // A record is owned by this root when the encoding names this root, or when
  // no encoding is present and the path resolves to an existing file here.
  // Ownership never depends on the file still existing, so a deleted file stays
  // an archive candidate; foreign roots resolve outside \`root\` and are skipped.
  const absoluteRoot = resolve(root)
  const bySource = new Map()
  const owned = new Map()
  for (const document of index.documents) {
    if (document.status !== 'active') continue
    const sourcePath = document.sourcePaths?.[0]
    if (typeof sourcePath !== 'string' || sourcePath === '') continue
    const { ownerRoot, relativePath } = splitSourcePath(sourcePath)
    let relativeForThisRoot
    if (ownerRoot !== undefined) {
      // Encoded paths are unambiguous: mismatch means a different root.
      if (resolve(ownerRoot) !== absoluteRoot) continue
      relativeForThisRoot = relativePath
    } else {
      // A legacy bare path carries no root. Adopt it for updates only when the
      // file exists here, and never treat it as an archive candidate: an
      // ambiguous record must not be archived on a guess.
      const candidate = join(root, ...relativePath.split('/'))
      if (!existsSync(candidate)) continue
      relativeForThisRoot = relativePath
    }
    const absolute = join(root, ...relativeForThisRoot.split('/'))
    if (existsSync(absolute)) bySource.set(relativeForThisRoot, document)
    else owned.set(relativeForThisRoot, document)
  }

  const plan = { create: [], update: [], archive: [] }
  const seen = new Set()

  for (const absolute of files) {
    const relPath = toRelative(root, absolute)
    const parsed = readSource(absolute, minBytes)
    if (parsed === undefined) continue
    seen.add(relPath)
    const titleBase = basename(absolute, '.md')
    const directory = relPath.includes('/') ? relPath.split('/')[0] + ' - ' : ''
    const title = (directory + titleBase).slice(0, 160)
    const description = makeDescription(relPath, parsed.body)
    const existing = bySource.get(relPath)

    if (existing !== undefined) {
      if (existing.contentHash === parsed.hash) continue
      plan.update.push({
        record: {
          ...existing, title, description,
          contentHash: parsed.hash,
          updatedAt: new Date().toISOString(),
          revision: existing.revision + 1,
        },
        content: parsed.body,
      })
      continue
    }

    const now = new Date().toISOString()
    const id = randomUUID()
    const filename = slug(title) + '-' + id.slice(0, 8) + '.md'
    plan.create.push({
      record: {
        id, title, description, status: 'active',
        filename,
        // The Source resolves <storageRoot>/<relativePath> and rejects anything
        // outside <storageRoot>/documents. An empty value resolves to the storage
        // root itself, which fails that check and makes the whole Source report
        // unavailable, so this must always be the managed path.
        relativePath: 'documents/active/' + filename,
        sourcePaths: [makeSourcePath(root, relPath)], sessionIds: [],
        createdAt: now, updatedAt: now, lastAccessedAt: now,
        revision: 1, contentHash: parsed.hash, sizeBytes: 0, memoryBodyIds: [],
      },
      content: parsed.body,
    })
  }

  if (prune) {
    for (const document of owned.values()) plan.archive.push(document)
  }
  return plan
}

/**
 * Coalesce rapid file-system events into one reconciliation per root.
 */
class Debouncer {
  /** @param {number} windowMs Quiet window before firing. */
  constructor(windowMs) {
    this.windowMs = windowMs
    this.timers = new Map()
  }

  /**
   * Schedule work for a key.
   * @param {string} key Root key.
   * @param {() => void} task Work to run.
   */
  schedule(key, task) {
    const existing = this.timers.get(key)
    if (existing !== undefined) clearTimeout(existing)
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key)
      task()
    }, this.windowMs))
  }

  /** Drop every pending timer. */
  dispose() {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }
}

/**
 * Mount the sync monitor.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx Cordis context.
 * @param {object} [config] Plugin configuration.
 * @param {boolean} [config.enabled] Master switch.
 * @param {string[]} [config.roots] Knowledge-base roots to watch.
 * @param {string} [config.storeDirectory] Documents store; defaults to ~/.mnemon/documents.
 * @param {number} [config.debounceMs] Quiet window before reconciling.
 * @param {number} [config.minBytes] Smallest accepted file.
 * @param {boolean} [config.prune] Archive records whose source disappeared.
 * @param {boolean} [config.dryRun] Detect and log without writing.
 * @param {number} [config.limitBytes] Active capacity ceiling.
 * @param {(message: string) => void} [config.log] Logger.
 */
export function apply(ctx, config = {}) {
  const enabled = config.enabled ?? true
  if (!enabled) return

  const log = config.log ?? ((message) => console.log('[mnemon-sync-monitor] ' + message))
  let roots = (config.roots ?? []).map((root) => resolve(root))
  const debounceMs = config.debounceMs ?? 800
  const minBytes = config.minBytes ?? 200
  const prune = config.prune ?? false
  const dryRun = config.dryRun ?? false
  const limitBytes = config.limitBytes ?? DEFAULT_LIMIT_BYTES
  const store = new DocumentsStore(resolveStoreDirectory(config.storeDirectory))
  const debouncer = new Debouncer(debounceMs)
  const watchers = new Map()
  let disposed = false

  /**
   * Reconcile one root and report the outcome.
   * @param {string} root Absolute root.
   * @param {string} reason Why the pass ran.
   * @returns {{created: number, updated: number, archived: number, skipped: number}} Counts.
   */
  const reconcile = (root, reason) => {
    const empty = { created: 0, updated: 0, archived: 0, skipped: 0 }
    try {
      const index = store.readIndex()
      const plan = planSync({ root, index, minBytes, prune })
      const size = plan.create.length + plan.update.length + plan.archive.length
      if (size === 0) return empty
      if (dryRun) {
        log('[dry-run] ' + root + ' (' + reason + '): create ' + plan.create.length
          + ', update ' + plan.update.length + ', archive ' + plan.archive.length)
        return empty
      }
      const counts = store.apply(plan, { limitBytes })
      log(root + ' (' + reason + '): created ' + counts.created
        + ', updated ' + counts.updated + ', archived ' + counts.archived
        + (counts.skipped > 0 ? ', skipped ' + counts.skipped : ''))
      return counts
    } catch (error) {
      log('reconcile failed for ' + root + ': ' + (error instanceof Error ? error.message : String(error)))
      return empty
    }
  }

  /** Attach a recursive watcher for one root. */
  const watchRoot = (root) => {
    if (watchers.has(root) || disposed) return
    if (!existsSync(root)) { log('root does not exist, skipping: ' + root); return }
    try {
      const watcher = watch(root, { recursive: true, persistent: false }, (_event, filename) => {
        if (typeof filename === 'string' && !filename.toLowerCase().endsWith('.md')) return
        debouncer.schedule(root, () => reconcile(root, 'change'))
      })
      watcher.on('error', (error) => log('watcher error on ' + root + ': ' + error.message))
      watchers.set(root, watcher)
      // Startup reconciliation covers files written while the host was down.
      reconcile(root, 'startup')
      log('watching ' + root)
    } catch (error) {
      log('cannot watch ' + root + ': ' + (error instanceof Error ? error.message : String(error)))
    }
  }

  /** Detach the watcher for one root. */
  const unwatchRoot = (root) => {
    const watcher = watchers.get(root)
    if (watcher === undefined) return
    try { watcher.close() } catch (closeError) {
      if (closeError.code !== 'ERR_INVALID_STATE') throw closeError
    }
    watchers.delete(root)
    debouncer.dispose()
    log('stopped watching ' + root)
  }

  for (const root of roots) watchRoot(root)

  /**
   * Persist a new root list and apply it live.
   * @param {string[]} next Absolute roots.
   * @returns {Promise<{restartRequired: boolean, changed: boolean}>} Outcome.
   */
  const setRoots = async (next) => {
    const patch = config.patchPath ?? resolveProfilePatch()
    if (patch === undefined) throw new Error('no profile patch file is resolvable; cannot persist roots')
    const result = writeRoots(patch, next)
    const previous = roots
    roots = next
    for (const root of previous) if (!next.some((value) => resolve(value) === resolve(root))) unwatchRoot(root)
    for (const root of next) if (!previous.some((value) => resolve(value) === resolve(root))) watchRoot(root)
    return { restartRequired: false, changed: result.changed }
  }

  // ---- management route for the settings page ----
  const webServer = ctx?.webServer
  if (webServer !== undefined && typeof webServer.register === 'function') {
    const connection = ctx?.connection
    const reject = connection !== undefined && typeof connection.requestRejection === 'function'
      ? (req) => connection.requestRejection(req)
      : () => 503
    const patchPath = config.patchPath ?? resolveProfilePatch()
    const handler = createHandler({
      // Report the file when it is readable: it is what a restart would load,
      // so a manual edit shows up instead of being silently out of sync.
      getRoots: () => (patchPath === undefined ? [...roots] : readRoots(patchPath)),
      getLiveRoots: () => [...roots],
      setRoots,
      rescan: () => { for (const root of roots) reconcile(root, 'manual') },
      reject,
    })
    const disposable = webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler })
    ctx?.effect?.(() => () => {
      if (typeof disposable === 'function') disposable()
    })
    log('management route mounted at ' + ROUTE_PREFIX)
  } else {
    log('no webServer service; management route not mounted (watcher still active)')
  }

  ctx?.effect?.(() => () => {
    disposed = true
    debouncer.dispose()
    for (const [root, watcher] of watchers) {
      try { watcher.close() } catch (closeError) {
        if (closeError.code !== 'ERR_INVALID_STATE') throw closeError
      }
      watchers.delete(root)
    }
    log('stopped')
  })
}