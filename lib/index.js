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
import { readdirSync, readFileSync, writeFileSync, unlinkSync, statSync, existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { extname, join, relative, basename, resolve, sep, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  DocumentsStore, DEFAULT_LIMIT_BYTES, makeDescription, sha256,
  slug, stripFrontmatter,
} from './store.js'
import { spawn } from 'node:child_process'
import { ROUTE_PREFIX, createHandler, resolveProfilePatch, setLiveStore } from './server.js'
import { ActivityHub, attachEventStream } from './events.js'
import { runDistillPass, computeCoverage, normalizeConcurrency } from './distill.js'
import { canonicalRoots } from './roots.js'
import {
  readRoots, writeRoots, readDistillModel, writeDistillModel,
  readDistillEnabled, writeDistillEnabled,
  readDistillEffort, writeDistillEffort, DEFAULT_DISTILL_EFFORT, DISTILL_EFFORTS,
  readDistillConcurrency, writeDistillConcurrency,
  DISTILL_CONCURRENCY_DEFAULT, DISTILL_CONCURRENCY_MAX,
} from './persist.js'

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

/** Directories never scanned for Markdown. Shared with changes.js so the
 * Documents sync and the distill pass agree on what counts as a note.
 * These are tooling/build/cache sidecars, not knowledge-base content: .agents
 * holds installed skills, logseq/ holds Logseq's own metadata, .git/ the VCS
 * data. Indexing them produces duplicate or irrelevant records. */
const EXCLUDE_SEGMENTS = new Set([
  '.git', '.agents', '.trash', '.obsidian', '.recycle', 'node_modules', '.venv',
  'dist', '.next', '.cache', 'logseq', 'assets', 'bak',
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

  /**
   * Drop the pending timer for ONE key.
   *
   * Removing a root must not cancel work queued by the roots that are still
   * watched, which is what calling dispose() here used to do.
   * @param {string} key Root key.
   */
  cancel(key) {
    const timer = this.timers.get(key)
    if (timer === undefined) return
    clearTimeout(timer)
    this.timers.delete(key)
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
 * @param {object} [config.distill] Distillation sidecar settings.
 * @param {boolean} [config.distill.enabled] Run a distillation pass after each sync.
 * @param {boolean} [config.distill.automatic] Trigger from the watcher, not only a route.
 * @param {number} [config.distill.debounceMs] Quiet window before distilling.
 * @param {number} [config.distill.maxFilesPerRun] Files distilled per pass.
 * @param {number} [config.distill.maxInsightsPerFile] Insights per file.
 * @param {string} [config.distill.command] Shell command for the model call.
 * @param {(messages: object[]) => Promise<string>} [config.distill.complete] Injected model call.
 * @param {(message: string) => void} [config.log] Logger.
 */
export function apply(ctx, config = {}) {
  const enabled = config.enabled ?? true
  if (!enabled) return

  const log = config.log ?? ((message) => console.log('[mnemon-sync-monitor] ' + message))
  // A root nested inside another root is not a second workspace: it is the same
  // files reached by a second path, and each path owns an independent ledger. So
  // the inner root is dropped here, once, instead of being walked, watched, synced
  // and distilled a second time forever. Outermost root wins; the surviving order
  // is the configured order, because that is the order the page shows and the
  // round-robin budget cycles through.
  const canonicalAtBoot = canonicalRoots((config.roots ?? []).map((root) => resolve(root)))
  let roots = canonicalAtBoot.roots
  for (const dropped of canonicalAtBoot.dropped) {
    log(dropped.relation === 'inside'
      ? dropped.root + ' is inside ' + dropped.owner + '; watching the outer root only'
      : dropped.root + ' is listed twice; watching it once')
  }
  const debounceMs = config.debounceMs ?? 800
  const minBytes = config.minBytes ?? 200
  const prune = config.prune ?? false
  const dryRun = config.dryRun ?? false
  const limitBytes = config.limitBytes ?? DEFAULT_LIMIT_BYTES
  const storeDirectory = resolveStoreDirectory(config.storeDirectory)
  // Tell the management route which directory is really in use, so /state stops
  // reporting a default path while the watcher writes somewhere else.
  setLiveStore(storeDirectory)
  const store = new DocumentsStore(storeDirectory)
  const debouncer = new Debouncer(debounceMs)

  // ---- distillation sidecar ----
  // Runs beside the Documents sync: same roots, same change signal, different
  // destination (Memory Spaces instead of Documents). Off unless configured.
  // One shared patchPath for config reads/writes, declared before anything uses it.
  const patchPath = config.patchPath ?? resolveProfilePatch()
  const distillConfig = {
    // Live value: the Settings switch flips this without a restart. The saved
    // value wins over the bundled default so a restart preserves the choice.
    enabled: (patchPath === undefined ? undefined : readDistillEnabled(patchPath)) ?? config.distill?.enabled ?? false,
    automatic: config.distill?.automatic ?? true,
    debounceMs: config.distill?.debounceMs ?? 30_000,
    maxFilesPerRun: config.distill?.maxFilesPerRun ?? 10,
    maxInsightsPerFile: config.distill?.maxInsightsPerFile ?? 4,
    complete: config.distill?.complete,
    command: config.distill?.command,
    // 180 s was below the measured cost of a 12k-character note (~206 s), so long
    // notes always timed out. With the input window now capped at 4,000 characters a
    // call lands in ~12-40 s; the ceiling is raised anyway so a slow-but-working call
    // is never killed mid-flight.
    commandTimeoutMs: config.distill?.commandTimeoutMs ?? 300_000,
    // A pass is capped at maxFilesPerRun. With this on, finishing a pass with
    // backlog left queues the next one, so a 1,171-note backlog actually drains
    // instead of waiting for a file to be edited. Turn it off to distil only on
    // change events and manual triggers.
    autoContinue: config.distill?.autoContinue ?? true,
    // How hard the distillation model thinks before answering. Absent from the
    // profile means "use the default", NOT "inherit the model's own default":
    // measured on workbuddy/deepseek-v4.1-flash the model default is 'high', which
    // spends most of each call on reasoning for a task whose answer is a short
    // JSON list. 'low' is the default here for that reason.
    reasoningEffort:
      (patchPath === undefined ? undefined : readDistillEffort(patchPath))
      ?? config.distill?.reasoningEffort
      ?? DEFAULT_DISTILL_EFFORT,
    // How many notes are distilled at once. Authored value beats the bundle
    // default, same precedence as every other distill key; normalizeConcurrency
    // clamps a hand-edited 999 down to DISTILL_CONCURRENCY_MAX instead of letting
    // one typo spawn 999 children.
    concurrency: normalizeConcurrency(
      (patchPath === undefined ? undefined : readDistillConcurrency(patchPath))
      ?? config.distill?.concurrency,
    ),
  }
  const distillTimer = { handle: undefined }
  let distillRunning = false
  // Observable state for the Settings page. Every field it renders is published
  // from here; the page holds no timer and derives nothing on its own.
  const hub = new ActivityHub()
  // Seed the one field a page renders before any pass has run, so the Settings
  // picker shows the configured worker count instead of "正在读取…" until the
  // first note finishes.
  hub.setState({ concurrency: distillConfig.concurrency })

  // ---- Model selection ----
  // Single source of truth: the SAME llm registry the main composer's model
  // picker uses (ctx.llm.listProviders / listModels). No second catalog, no
  // gateway /v1/models probe. When a provider disappears, the list changes by
  // itself and the user can pick another without editing a plugin file.
  const storedSelection = patchPath === undefined ? undefined : readDistillModel(patchPath)
  let selectedModel = storedSelection ?? undefined

  /** List routable models in the composer's own [provider, model] identity. */
  const listModels = async () => {
    const llm = ctx?.get?.('llm')
    if (llm === undefined || typeof llm.listProviders !== 'function') return []
    const groups = []
    for (const provider of llm.listProviders()) {
      try {
        const models = await llm.listModels(provider.id)
        for (const model of models) {
          // Embedding/vision-only entries are not chat distillers.
          if (typeof model?.id !== 'string') continue
          groups.push({
            provider: provider.id,
            providerName: provider.name ?? provider.id,
            model: model.id,
            name: model.name ?? model.id,
            value: JSON.stringify([provider.id, model.id]),
          })
        }
      } catch {
        // One failing provider must not hide the others, exactly as the
        // composer's buildModelCatalog isolates provider failures.
      }
    }
    return groups
  }

  /** Persist a selection and apply it to the live config. */
  const setModel = (selection) => {
    if (patchPath === undefined) throw new Error('no profile patch file resolvable')
    const result = writeDistillModel(patchPath, selection)
    selectedModel = selection ?? undefined
    return result
  }

  /** Flip distillation on/off immediately, and persist the choice. */
  const setDistillEnabled = (enabled) => {
    if (patchPath === undefined) throw new Error('no profile patch file resolvable')
    const result = writeDistillEnabled(patchPath, enabled)
    distillConfig.enabled = enabled
    // Turning it off must also drop a queued pass, otherwise a timer already
    // scheduled would still fire after the user switched it off.
    if (!enabled && distillTimer.handle !== undefined) {
      clearTimeout(distillTimer.handle)
      distillTimer.handle = undefined
    }
    // Other tabs (or this one after a reload) learn about the flip from the
    // stream rather than polling for it.
    hub.setState({
      phase: enabled ? (distillRunning ? 'running' : 'idle') : 'idle',
      nextRunAt: enabled ? hub.state.nextRunAt : undefined,
    })
    hub.note(enabled ? '语义蒸馏已开启' : '语义蒸馏已关闭，排队的调度已取消')
    return result
  }

  /**
   * The reasoning tiers the SELECTED model actually accepts.
   *
   * Read from the same llm registry the composer uses, so the menu cannot offer a
   * value the gateway would reject. The gateway validates an effort against the
   * exact model and answers 400 with the allowed list, so guessing here would just
   * move the failure one call later.
   *
   * A model with no reasoning control answers `supported: false` rather than a
   * canonical fallback: offering "low/high/max" for a model that accepts none of
   * them would produce a switch that silently does nothing.
   */
  const listEfforts = async () => {
    const base = {
      efforts: [],
      supported: false,
      modelDefault: null,
      // What the plugin will send right now; null means "no override at all".
      effective: effectiveEffort() ?? null,
      configuredDefault: DEFAULT_DISTILL_EFFORT,
      model: selectedModel === undefined ? null : selectedModel.provider + '/' + selectedModel.model,
    }
    const llm = ctx?.get?.('llm')
    if (llm === undefined || typeof llm.resolveModelInfo !== 'function' || selectedModel === undefined) {
      // No model chosen yet: show the canonical tiers so the control still exists,
      // and say so rather than pretending these came from a model.
      return { ...base, efforts: DISTILL_EFFORTS.map((id) => ({ id, name: id })), supported: true, source: 'canonical' }
    }
    try {
      const info = await llm.resolveModelInfo(selectedModel.provider, selectedModel.model)
      const efforts = info?.reasoning?.efforts
      if (!Array.isArray(efforts) || efforts.length === 0) {
        return { ...base, source: 'model', note: '该模型未声明思考档位' }
      }
      return {
        ...base,
        efforts: efforts.map((effort) => ({
          id: effort.id,
          name: effort.name ?? effort.id,
          ...(effort.description === undefined ? {} : { description: effort.description }),
        })),
        supported: true,
        modelDefault: info.reasoning?.defaultEffort ?? null,
        source: 'model',
      }
    } catch (error) {
      // A provider outage must not kill the control: fall back to the canonical
      // list and let the gateway do the final validation.
      return {
        ...base,
        efforts: DISTILL_EFFORTS.map((id) => ({ id, name: id })),
        supported: true,
        source: 'fallback',
        note: String(error?.message ?? error),
      }
    }
  }

  /**
   * Reasoning effort applied to distillation calls.
   *
   * An empty value means "let the model decide", which is the one setting that
   * genuinely differs from every other: it sends NO override at all rather than
   * substituting the default, so the adapter's own effort applies.
   */
  const effectiveEffort = () => {
    const value = distillConfig.reasoningEffort
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
  }

  /**
   * Change the reasoning effort live and persist it.
   *
   * @param {string|null} effort Effort id, or null to clear the override.
   * @returns {{changed: boolean, backup?: string, created?: boolean}} Persist result.
   */
  const setDistillEffort = (effort) => {
    if (patchPath === undefined) throw new Error('no profile patch file resolvable')
    const result = writeDistillEffort(patchPath, effort === null ? null : String(effort))
    distillConfig.reasoningEffort = effort === null ? undefined : String(effort)
    // The effort is read at call time by completeVia(), so the next note in an
    // already-running pass picks it up — no restart and no new pass required.
    hub.setState({ reasoningEffort: effectiveEffort() ?? null })
    hub.note(effort === null
      ? '蒸馏思考等级：跟随模型默认'
      : '蒸馏思考等级：' + String(effort))
    return result
  }

  /** Resolve the currently selected pair into the gateway model id. */
  const effectiveModelId = () => {
    if (selectedModel === undefined) return undefined
    return selectedModel.provider + '/' + selectedModel.model
  }

  /**
   * Change how many notes distil at once, live and persisted.
   *
   * Takes effect for the NEXT note a worker picks up: the pool re-reads
   * `distillConfig.concurrency` at every worker start, and a running pass keeps
   * its already-started workers. That is deliberate — shrinking the pool must not
   * abandon a note mid-call and lose the model tokens already spent on it.
   *
   * @param {number|string} next Requested worker count, clamped to [1, MAX].
   * @returns {{changed: boolean, backup?: string, created?: boolean, concurrency: number}}
   */
  const setDistillConcurrency = (next) => {
    const parsed = typeof next === 'string' ? Number(next.trim()) : next
    if (typeof parsed !== 'number' || !Number.isFinite(parsed) || !Number.isInteger(parsed)) {
      throw new Error('concurrency must be an integer')
    }
    // Reject out-of-range instead of clamping silently: a page that sent 12 must
    // not then display 8 while the user believes 12 is configured.
    if (parsed < 1 || parsed > DISTILL_CONCURRENCY_MAX) {
      throw new RangeError('concurrency must be between 1 and ' + DISTILL_CONCURRENCY_MAX)
    }
    let result = { changed: false }
    if (patchPath !== undefined) result = writeDistillConcurrency(patchPath, parsed)
    distillConfig.concurrency = parsed
    hub.setState({ concurrency: parsed })
    hub.note(parsed === 1
      ? '并发蒸馏：1 个 Agent（逐个处理）'
      : '并发蒸馏：' + parsed + ' 个 Agent 并行')
    return { ...result, concurrency: parsed }
  }

  /**
   * Model call: an injected function wins, else the configured shell command.
   *
   * The command is run with async spawn, NOT execFileSync. execFileSync blocks the
   * Host's event loop for the whole model call — measured at 6-12 s per note on
   * hy4free — which stalls the Documents sync that shares this process. spawn keeps
   * the loop free and lets the caller await the result.
   */
/**
 * Persist one distilled conclusion into the Memory Space through the Mnemon CLI.
 *
 * The CLI owns dedupe, embedding and graph edges, so the plugin never writes the
 * database itself. Two Windows details matter:
 *   - the npm global bin directory is not reliably inherited by a Host-spawned
 *     process, so the binary is resolved from dirname(process.execPath) first;
 *   - the .cmd shim must run through ComSpec, not through 'shell: true'.
 *
 * MNEMON_EMBED_MODEL is forced to the Host's configured model. Without it the CLI
 * falls back to its own default (nomic-embed-text, 768-d) and writes a vector that
 * cannot be compared with the 1024-d rows already in the store -- the exact split
 * that made a third of the reference store unreachable.
 *
 * @param {object} insight Distilled conclusion.
 * @param {(message: string) => void} log Logger.
 * @returns {Promise<void>}
 */
async function persistThroughCli(insight, log) {
  const launcher = await resolveMnemonBinary()
  if (launcher === undefined) throw new Error('mnemon CLI not found; cannot persist distilled insights')
  const draft = {
    schema_version: '1',
    insights: [{
      content: insight.content,
      category: insight.category ?? 'insight',
      importance: insight.importance ?? 3,
      tags: Array.isArray(insight.tags) ? insight.tags : [],
      entities: Array.isArray(insight.entities) ? insight.entities : [],
      created_at: new Date().toISOString(),
    }],
  }
  const tmp = join(tmpdir(), 'dsh-mnemon-distill-' + randomUUID() + '.json')
  writeFileSync(tmp, JSON.stringify(draft), 'utf8')
  let ids = []
  try {
    await new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(launcher.command, [...launcher.args, 'import', tmp], {
        shell: launcher.useShell,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          MNEMON_EMBED_MODEL: process.env.MNEMON_EMBED_MODEL ?? 'bge-m3',
        },
      })
      let stderr = ''
      let stdout = ''
      child.stderr.on('data', (chunk) => { stderr += chunk })
      child.stdout.on('data', (chunk) => { stdout += chunk })
      const timer = setTimeout(() => {
        try { child.kill('SIGTERM') } catch { /* already gone */ }
        rejectPromise(new Error('mnemon import timed out'))
      }, 120000)
      child.on('error', (error) => { clearTimeout(timer); rejectPromise(error) })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0) {
          // `mnemon import` prints {results:[{id, action}]}. Returning the ids lets the
          // distillation ledger link a note's content hash to the nodes it produced.
          try {
            const parsed = JSON.parse(stdout)
            ids = (parsed.results ?? []).map((r) => r.id).filter((id) => typeof id === 'string')
          } catch { /* output shape changed; the ledger still records the hash */ }
          resolvePromise(ids)
        } else {
          rejectPromise(new Error('mnemon import exited ' + code + ': ' + stderr.trim().slice(0, 200)))
        }
      })
    })
    if (log !== undefined) log('[distill] persisted: ' + insight.content.slice(0, 50))
    return ids
  } finally {
    try { unlinkSync(tmp) } catch { /* best effort */ }
  }
}

/**
 * Locate a runnable Mnemon CLI without trusting PATH.
 * @returns {Promise<object|undefined>} Invocation descriptor.
 */
async function resolveMnemonBinary() {
  const exe = dirname(process.execPath)
  const cut = exe.search(/[\\/]node_modules[\\/]/u)
  const prefix = cut > 0 ? exe.slice(0, cut) : exe
  const candidates = [
    // 1. Next to the running node.exe (stock Windows installer layout).
    join(prefix, 'mnemon.cmd'),
    join(prefix, 'bin', 'mnemon.cmd'),
    join(exe, 'mnemon.cmd'),
    // 2. The npm global prefix. On an nvm-for-windows install node.exe lives under
    //    ...\nvm4w_nodejs\nodejs\ while npm puts shims in %APPDATA%\npm, so the
    //    sibling-directory guess above finds nothing. This is the common case.
    join(process.env.APPDATA ?? '', 'npm', 'mnemon.cmd'),
    join(process.env.LOCALAPPDATA ?? '', 'npm', 'mnemon.cmd'),
  ]
  const comspec = process.env.ComSpec ?? process.env.COMSPEC
  for (const shim of candidates) {
    if (shim === '' || !existsSync(shim)) continue
    if (comspec !== undefined) return { command: comspec, args: ['/c', shim], useShell: false }
    return { command: shim, args: [], useShell: true }
  }
  // 3. Last resort: let the shell resolve it from PATH.
  if (comspec !== undefined) return { command: comspec, args: ['/c', 'mnemon'], useShell: false }
  return undefined
}
  const completeVia = () => {
    if (typeof distillConfig.complete === 'function') return distillConfig.complete
    const command = typeof distillConfig.command === 'string' ? distillConfig.command.trim() : ''
    if (command === '') return undefined
    return (messages) => new Promise((resolve, reject) => {
      const child = spawn(command, {
        shell: true,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          // The adapter reads DISTILL_MODEL. An explicit composer selection wins
          // over its built-in default; this is the only place the choice is
          // applied, so the UI and the actual call can never diverge.
          ...(effectiveModelId() === undefined
            ? {}
            : { DISTILL_MODEL: effectiveModelId() }),
          // The adapter applies its OWN timeout (default 120 s) and aborts the fetch.
          // Without this the plugin's larger ceiling never applies: the child would
          // already have exited with 'aborted due to timeout' before the parent's
          // timer fired, which is exactly what the logs showed.
          DISTILL_TIMEOUT_MS: String(distillConfig.commandTimeoutMs ?? 300_000),
          // The adapter forwards this as reasoning_effort on the chat request.
          // Omitted entirely when unset, so "model default" stays expressible.
          ...(effectiveEffort() === undefined ? {} : { DISTILL_EFFORT: effectiveEffort() }),
        },
      })
      let out = ''
      let err = ''
      const timer = setTimeout(() => {
        try { child.kill('SIGTERM') } catch { /* already gone */ }
        reject(new Error('distill command timed out'))
      }, distillConfig.commandTimeoutMs)
      timer.unref?.()
      child.stdout.on('data', (chunk) => { out += String(chunk) })
      child.stderr.on('data', (chunk) => { err += String(chunk) })
      child.on('error', (error) => { clearTimeout(timer); reject(error) })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0) { resolve(out); return }
        reject(new Error('distill command exited ' + code + (err.trim() === '' ? '' : ': ' + err.trim().slice(0, 300))))
      })
      // Closing stdin is what lets the adapter finish reading its payload.
      child.stdin.on('error', () => { /* the child may exit before reading */ })
      child.stdin.write(JSON.stringify({ messages }))
      child.stdin.end()
    })
  }

  /** Recompute the backlog and publish it. Cheap enough to run once per pass. */
  const refreshCoverage = () => {
    try {
      const report = computeCoverage({ roots, store: storeDirectory })
      hub.setState({
        coverage: {
          scanned: report.scanned,
          distilled: report.distilled,
          pending: report.pending,
          at: new Date().toISOString(),
        },
      })
      return report
    } catch (error) {
      hub.setState({ coverage: { error: String(error?.message ?? error) } })
      return undefined
    }
  }

  /**
   * Rebuild the published `current` from an event's in-flight snapshot.
   *
   * With a pool, "the note being distilled" is a set, not a single name. The
   * event carries the authoritative snapshot taken by the worker at the instant
   * it emitted, so this never has to guess: it renders exactly what the pool
   * holds. `file`/`bytes`/`startedAt` are kept as the most recently started note
   * so every existing reader of `current.file` keeps working unchanged.
   *
   * @param {object} event A note-start / note-done / note-failed event.
   * @param {string} root Root the note belongs to.
   * @returns {object|undefined} Published `current`, or undefined when idle.
   */
  const currentFromEvent = (event, root) => {
    const files = Array.isArray(event.files) ? event.files : []
    if (files.length === 0) return undefined
    const newest = files[files.length - 1]
    return {
      file: newest.file,
      root,
      bytes: newest.bytes,
      startedAt: new Date(newest.startedAt).toISOString(),
      // The whole in-flight set, so the page can list several notes at once.
      active: files.length,
      files: files.map((entry) => ({
        file: entry.file,
        bytes: entry.bytes,
        startedAt: new Date(entry.startedAt).toISOString(),
      })),
    }
  }

  /**
   * Translate one pass event into published state.
   *
   * The pass reports what it is doing; this decides what a page should see. Kept
   * apart so the distillation logic stays unaware of transport and presentation.
   */
  const onPassEvent = (event) => {
    switch (event.type) {
      case 'root':
        hub.setState({
          budget: {
            ...hub.state.budget,
            planned: hub.state.budget.planned + event.batch,
          },
        })
        break
      case 'note-start':
        hub.setState({ current: currentFromEvent(event, event.root) })
        hub.note('正在蒸馏 ' + event.file, { file: event.file, root: event.root })
        break
      case 'note-done': {
        // Move the coverage ledger INCREMENTALLY, not only when the pass ends.
        // A pass runs 10 notes at minutes-per-note, so refreshing coverage once
        // per pass left the bar frozen for the whole batch - the count looked
        // stuck even though the activity log scrolled. A note is recorded in the
        // ledger before this event fires, so one distilled note is exactly one
        // unit of progress; pending cannot go below zero.
        const coverage = hub.state.coverage
        const next = coverage === undefined || typeof coverage.distilled !== 'number'
          ? coverage
          : {
              ...coverage,
              distilled: coverage.distilled + 1,
              pending: Math.max(0, (coverage.pending ?? 0) - 1),
              at: new Date().toISOString(),
            }
        hub.setState({
          // NOT `current: undefined`: other workers may still be mid-call, and
          // clearing it here made the panel flicker to idle after every note.
          current: currentFromEvent(event, event.root),
          budget: { ...hub.state.budget, done: hub.state.budget.done + 1 },
          insights: {
            proposed: hub.state.insights.proposed + event.proposed,
            persisted: hub.state.insights.persisted + event.written,
          },
          ...(next === undefined ? {} : { coverage: next }),
        })
        hub.note(event.file + ' → ' + event.written + ' 条洞察', { file: event.file, root: event.root })
        break
      }
      case 'note-failed':
        hub.setState({
          current: currentFromEvent(event, event.root),
          budget: { ...hub.state.budget, failed: hub.state.budget.failed + 1 },
          lastError: event.error,
        })
        hub.note(event.file + ' 蒸馏失败：' + event.error, { file: event.file, root: event.root, error: event.error })
        break
      default:
        break
    }
  }

  /** One distillation pass. Swallows every error: Documents sync must survive. */
  const distillPass = async (reason) => {
    if (!distillConfig.enabled || distillRunning || disposed) return undefined
    const complete = completeVia()
    if (complete === undefined) {
      log('[distill] skipped (' + reason + '): no model configured '
        + '(set distill.complete or distill.command)')
      hub.setState({ phase: 'idle', running: false, lastError: '未配置蒸馏命令' })
      return undefined
    }
    distillRunning = true
    hub.setState({
      phase: 'running',
      running: true,
      reason,
      startedAt: new Date().toISOString(),
      finishedAt: undefined,
      nextRunAt: undefined,
      current: undefined,
      budget: { planned: 0, done: 0, failed: 0 },
      insights: { proposed: 0, persisted: 0 },
    })
    hub.note('开始蒸馏（' + reason + '）', { reason })
    try {
      const report = await runDistillPass({
        roots,
        store: storeDirectory,
        complete,
        log,
        maxFilesPerRun: distillConfig.maxFilesPerRun,
        maxInsightsPerFile: distillConfig.maxInsightsPerFile,
        // Read here rather than captured above: the Settings page can change it
        // while a pass is queued, and the next pass must pick that up.
        concurrency: distillConfig.concurrency,
        dryRun,
        // Without this the pass distilled and threw the conclusions away, while the
        // Settings page claimed they were being written to Memory Space. The sink is
        // the Mnemon CLI, which owns dedupe, embedding and graph edges.
        persistInsight: (insight) => persistThroughCli(insight, log),
        onEvent: onPassEvent,
      })
      log('[distill] ' + reason + ': roots=' + report.roots.length
        + ' files=' + report.files + ' proposed=' + report.proposed
        + (report.errors.length > 0 ? ' errors=' + report.errors.length : ''))
      for (const shadowed of report.shadowed ?? []) {
        log('[distill]   shadowed ' + shadowed.root + ' (covered by ' + shadowed.owner + ')')
      }
      for (const entry of report.roots) {
        if (entry.note !== undefined) log('[distill]   ' + entry.root + ': ' + entry.note)
      }
      for (const error of report.errors.slice(0, 3)) {
        log('[distill]   error ' + (error.file ?? error.root) + ': ' + error.error)
      }
      // Coverage is refreshed from the ledger, not incremented from counters: an
      // increment can drift, a set difference cannot.
      const after = refreshCoverage()
      hub.setState({
        phase: 'finished',
        running: false,
        finishedAt: new Date().toISOString(),
        current: undefined,
      })
      hub.note('本轮结束：' + report.files + ' 篇 / ' + report.persisted + ' 条写入'
        + (report.errors.length > 0 ? '，' + report.errors.length + ' 个错误' : ''))

      // ---- backlog continuation ----
      // A pass is capped at maxFilesPerRun. Without chaining, the remaining
      // backlog is only ever revisited when a FILE CHANGES, so a vault with 1,171
      // pending notes and 10 per pass effectively never finishes: the bar sits at
      // the same number forever. The next pass is queued through the same
      // debounce timer, so the switch, the manual trigger and dispose() all keep
      // working unchanged.
      const remaining = after === undefined ? 0 : after.pending
      if (remaining > 0 && distillConfig.autoContinue && distillConfig.enabled && !disposed) {
        scheduleDistill('backlog: ' + remaining + ' 篇待蒸馏', { force: true })
      }
      return report
    } catch (error) {
      log('[distill] failed: ' + (error instanceof Error ? error.message : String(error)))
      hub.setState({
        phase: 'failed',
        running: false,
        finishedAt: new Date().toISOString(),
        current: undefined,
        lastError: error instanceof Error ? error.message : String(error),
      })
      hub.note('蒸馏异常：' + (error instanceof Error ? error.message : String(error)))
      return undefined
    } finally {
      distillRunning = false
    }
  }

  /**
   * Coalesce bursts: watch events are frequent, distillation is expensive.
   *
   * @param {string} reason Why a pass is being queued, shown in the UI.
   * @param {object} [options] Scheduling flags.
   * @param {boolean} [options.force] Queue even when automatic scheduling is off.
   *   The backlog continuation uses this: a user who asked for manual triggering
   *   still expects ONE manual pass to finish the backlog it started, rather
   *   than stop at maxFilesPerRun and wait for another click.
   */
  const scheduleDistill = (reason, options = {}) => {
    if (!distillConfig.enabled || disposed) return
    if (!distillConfig.automatic && options.force !== true) return
    if (distillTimer.handle !== undefined) clearTimeout(distillTimer.handle)
    const dueAt = Date.now() + distillConfig.debounceMs
    distillTimer.handle = setTimeout(() => {
      distillTimer.handle = undefined
      void distillPass(reason)
    }, distillConfig.debounceMs)
    distillTimer.handle.unref?.()
    // Published so the page can show a countdown WITHOUT a timer of its own.
    // A queued pass is a real state the user should see; it used to be invisible
    // unless automatic scheduling happened to be on.
    if (distillRunning !== true) {
      hub.setState({ phase: 'queued', nextRunAt: new Date(dueAt).toISOString(), reason })
    }
  }
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
      // Sync is visible too, not just distillation: a file landing in Documents
      // is the event a user expects to see acknowledged.
      hub.setState({
        documents: {
          root,
          created: (hub.state.documents?.created ?? 0) + counts.created,
          updated: (hub.state.documents?.updated ?? 0) + counts.updated,
          archived: (hub.state.documents?.archived ?? 0) + counts.archived,
          at: new Date().toISOString(),
        },
      })
      if (counts.created + counts.updated + counts.archived > 0) {
        hub.note('同步 ' + root + '：新增 ' + counts.created + ' / 更新 ' + counts.updated
          + ' / 归档 ' + counts.archived, { root })
      }
      // Documents changed, so Memory Spaces may be behind: schedule a pass.
      scheduleDistill('after ' + reason + ' on ' + root)
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
      // Same reason for distillation: no event fires for edits made while DSH was
      // closed, so the git-commit / mtime comparison is what catches them up.
      scheduleDistill('startup')
      // One coverage walk per root at startup, published to the hub. This is the
      // ONLY scheduled scan: afterwards the number moves because a pass finished
      // or a file changed, never because a clock ticked.
      refreshCoverage()
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
    // Do NOT dispose the shared debouncer: it holds pending work for EVERY root, so
    // removing one root silently dropped the others' coalesced writes. Cancelling is
    // keyed by root instead.
    debouncer.cancel?.(root)
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
    // The route refuses an overlapping root before reaching this point, but this is
    // the last gate before the value is written to the profile: anything that
    // inherits a nested root from an older config or a hand-edited patch file is
    // folded to the outermost one here, and the file is rewritten with the
    // canonical set so the next start does not repeat the work.
    const canonical = canonicalRoots(next)
    for (const dropped of canonical.dropped) {
      log(dropped.relation === 'inside'
        ? dropped.root + ' is inside ' + dropped.owner + '; not watched separately'
        : dropped.root + ' is listed twice; not watched separately')
    }
    const result = writeRoots(patch, canonical.roots)
    const previous = roots
    roots = canonical.roots
    for (const root of previous) if (!canonical.roots.some((value) => resolve(value) === resolve(root))) unwatchRoot(root)
    for (const root of canonical.roots) if (!previous.some((value) => resolve(value) === resolve(root))) watchRoot(root)
    return { restartRequired: false, changed: result.changed, roots: [...canonical.roots], shadowed: canonical.dropped }
  }

  // ---- management route for the settings page ----
  const webServer = ctx?.webServer
  if (webServer !== undefined && typeof webServer.register === 'function') {
    const connection = ctx?.connection
    const reject = connection !== undefined && typeof connection.requestRejection === 'function'
      ? (req) => connection.requestRejection(req)
      : () => 503
    const handler = createHandler({
      // Report the file when it is readable: it is what a restart would load,
      // so a manual edit shows up instead of being silently out of sync.
      getRoots: () => (patchPath === undefined ? [...roots] : readRoots(patchPath)),
      getLiveRoots: () => [...roots],
      setRoots,
      rescan: () => { for (const root of roots) reconcile(root, 'manual') },
      // Manual distillation trigger + a status read, so the pass can be exercised
      // and observed without waiting for a watch event.
      distill: () => distillPass('manual'),
      coverage: () => computeCoverage({ roots, store: storeDirectory }),
      // The Settings page subscribes here instead of polling /state.
      attachEvents: (req, res) => attachEventStream({ hub, req, res, keepAliveMs: config.eventsKeepAliveMs }),
      listModels,
      getModel: () => (selectedModel === undefined ? null : { ...selectedModel }),
      setModel,
      setDistillEnabled,
      setDistillEffort,
      listEfforts,
      distillStatus: () => ({
        enabled: distillConfig.enabled,
        automatic: distillConfig.automatic,
        running: distillRunning,
        // Whether a pass can actually LAND its conclusions. The page promised
        // "自动写入 Memory Space" unconditionally while the pass only counted them.
        persists: true,
        // Ledger-based coverage: how many notes currently have distilled content.
        // "pending" is the set difference that decides what still needs a pass.
        coverage: (() => {
          try {
            const c = computeCoverage({ roots, store: storeDirectory })
            return { scanned: c.scanned, distilled: c.distilled, pending: c.pending, roots: c.roots }
          } catch (error) {
            return { error: String(error?.message ?? error) }
          }
        })(),
        debounceMs: distillConfig.debounceMs,
        maxFilesPerRun: distillConfig.maxFilesPerRun,
        maxInsightsPerFile: distillConfig.maxInsightsPerFile,
        // The live, observable view. Same object the SSE stream pushes, so a page
        // that loads /state and then subscribes sees one continuous story
        // instead of two number systems that can disagree.
        live: hub.state,
        subscribers: hub.subscriberCount,
        // Two different facts, kept apart because they fail for different reasons:
        //   hasModel     - a model CALL is wired up (complete / command configured)
        //   hasSelection - a specific [provider, model] is chosen
        // A profile row that predates the distill block has neither, and reporting
        // that as "未解析到模型" pointed at the wrong subsystem.
        hasModel: completeVia() !== undefined,
        hasCommand: typeof distillConfig.command === 'string' && distillConfig.command.trim() !== '',
        selectedModel: selectedModel ?? null,
        effectiveModelId: effectiveModelId() ?? null,
        // null means "no override": the adapter's own effort applies. Reported as
        // null rather than omitted so the page can tell "follow the model default"
        // from "the field was never read".
        reasoningEffort: effectiveEffort() ?? null,
        reasoningEffortDefault: DEFAULT_DISTILL_EFFORT,
        // How many notes this Host will distil at once, and the ceiling a page
        // may offer. Reported from the live config, not the patch file, so what
        // the page shows is what the next pass will actually do.
        concurrency: distillConfig.concurrency,
        concurrencyDefault: DISTILL_CONCURRENCY_DEFAULT,
        concurrencyMax: DISTILL_CONCURRENCY_MAX,
        pending: distillTimer.handle !== undefined,
      }),
      setDistillConcurrency,
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
    if (distillTimer.handle !== undefined) clearTimeout(distillTimer.handle)
    // Tell any open page the watcher stopped instead of leaving a stale
    // "正在蒸馏…" on screen for a process that is gone.
    hub.setState({ phase: 'idle', running: false, current: undefined, nextRunAt: undefined })
    hub.note('监听已停止')
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