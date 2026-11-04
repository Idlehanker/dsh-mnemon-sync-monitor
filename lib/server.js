/**
 * Host-side management route for the sync monitor.
 *
 * Exposes the watched roots as a small JSON API so a Settings page can list,
 * add, and remove them without hand-editing cordis.patch.yml.
 *
 * The route is a single \`prefix\` registration with internal dispatch. Every
 * request passes the connection trust fence before any path is matched, so an
 * unauthenticated caller cannot probe which routes exist.
 *
 * @module dsh-mnemon-sync-monitor/server
 */
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

/** Route prefix owned by this plugin. */
export const ROUTE_PREFIX = '/mnemon-sync-monitor'

/** Prefix for keys this plugin owns inside config files. */
const ROW_ID = 'mnemon-sync-monitor'

/**
 * Write a JSON response with the cache policy live facts require.
 * @param {import('node:http').ServerResponse} res Response.
 * @param {number} status HTTP status.
 * @param {unknown} body JSON body.
 */
export function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text, 'utf8'),
  })
  res.end(text)
}

/**
 * Read a request body as text, bounded.
 * @param {import('node:http').IncomingMessage} req Request.
 * @param {number} limit Maximum accepted bytes.
 * @returns {Promise<string>} Body text.
 */
function readBody(req, limit = 1_000_000) {
  return new Promise((resolvePromise, rejectPromise) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        rejectPromise(Object.assign(new Error('request body too large'), { code: 'too-large' }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')))
    req.on('error', rejectPromise)
  })
}

/**
 * Resolve the profile patch file that owns this plugin's configuration row.
 *
 * Several sources are tried, because no single one is reliable across launch
 * modes: the Desktop app does not export every DSH variable into the Host, while
 * a CLI launch does.
 *
 *   1. `DSH_PROFILE_DIR` — set by a CLI launch;
 *   2. `DSH_HOME` + `DSH_PROFILE` — the home and profile name, combined;
 *   3. the only profile under `$DSH_HOME/profiles` that lists this plugin — a
 *      profile that installed this bundle is the one that owns its row.
 *
 * @returns {string|undefined} Absolute path, when resolvable.
 */
export function resolveProfilePatch() {
  const home = process.env.DSH_HOME
  const profile = process.env.DSH_PROFILE
  const candidates = []

  const explicit = process.env.DSH_PROFILE_DIR
  if (explicit !== undefined && explicit.trim() !== '') {
    candidates.push(join(explicit.trim(), 'cordis.patch.yml'))
  }
  if (home !== undefined && home.trim() !== '' && profile !== undefined && profile.trim() !== '') {
    candidates.push(join(home.trim(), 'profiles', profile.trim(), 'cordis.patch.yml'))
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }

  // Fall back to finding the profile that installed this bundle. `homeDir` uses
  // the OS home rather than an environment variable, because the Desktop Host is
  // not guaranteed to export DSH_HOME to plugin processes.
  for (const base of [home?.trim(), join(homedir(), '.dsh')]) {
    if (base === undefined || base === '') continue
    const profilesDirectory = join(base, 'profiles')
    let entries
    try {
      entries = readdirSync(profilesDirectory, { withFileTypes: true })
    } catch {
      return undefined
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const patch = join(profilesDirectory, entry.name, 'cordis.patch.yml')
      if (!existsSync(patch)) continue
      try {
        if (readFileSync(patch, 'utf8').includes('dsh-mnemon-sync-monitor')) return patch
      } catch {
        continue
      }
    }
  }
  return undefined
}

/**
 * Read the configured roots for this plugin.
 *
 * Configuration lives in the profile patch layer. Rather than parse YAML into a
 * second source of truth, the running config is exposed through the snapshot the
 * plugin captured at mount; this reader only needs the file for the page's
 * "where is this stored" line.
 * @returns {string|undefined} Patch file path.
 */
export function describeStore() {
  const home = process.env.DSH_HOME
  const profile = process.env.DSH_PROFILE
  const explicit = process.env.DSH_PROFILE_DIR
  const attempts = []
  if (explicit !== undefined && explicit.trim() !== '') {
    const candidate = join(explicit.trim(), 'cordis.patch.yml')
    attempts.push({ source: 'DSH_PROFILE_DIR', path: candidate, exists: existsSync(candidate) })
  }
  if (home !== undefined && home.trim() !== '' && profile !== undefined && profile.trim() !== '') {
    const candidate = join(home.trim(), 'profiles', profile.trim(), 'cordis.patch.yml')
    attempts.push({ source: 'DSH_HOME+DSH_PROFILE', path: candidate, exists: existsSync(candidate) })
  }
  if (home !== undefined && home.trim() !== '') {
    attempts.push({ source: 'scan', path: join(home.trim(), 'profiles'), exists: existsSync(join(home.trim(), 'profiles')) })
  }
  return {
    store: process.env.MNEMON_SYNC_STORE ?? join(homedir(), '.mnemon', 'documents'),
    patch: resolveProfilePatch() ?? null,
    profile: profile ?? null,
    // Resolution evidence: what the plugin process actually sees. This is the
    // difference between "the file is missing" and "the env never arrived".
    env: { DSH_HOME: home ?? null, DSH_PROFILE: profile ?? null, DSH_PROFILE_DIR: explicit ?? null },
    attempts,
  }
}

/**
 * Validate a candidate root.
 * @param {unknown} value Candidate.
 * @returns {{ok: true, root: string} | {ok: false, reason: string}} Verdict.
 */
export function validateRoot(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return { ok: false, reason: 'root must be a non-empty string' }
  }
  const root = resolve(value.trim())
  if (!existsSync(root)) return { ok: false, reason: 'path does not exist: ' + root }
  let stats
  try {
    stats = statSync(root)
  } catch (error) {
    return { ok: false, reason: 'cannot stat path: ' + (error instanceof Error ? error.message : String(error)) }
  }
  if (!stats.isDirectory()) return { ok: false, reason: 'not a directory: ' + root }
  return { ok: true, root }
}

/**
 * Count Markdown files under a root, bounded to keep the page responsive.
 * @param {string} root Absolute directory.
 * @param {number} limit Stop after this many files.
 * @returns {number} Markdown file count.
 */
export function countMarkdown(root, limit = 20_000) {
  let count = 0
  const pending = [root]
  const excluded = new Set(['.git', '.trash', '.obsidian', 'node_modules', '.venv', 'dist'])
  while (pending.length > 0 && count < limit) {
    const directory = pending.pop()
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (excluded.has(entry.name)) continue
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) pending.push(absolute)
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) count += 1
    }
  }
  return count
}

/**
 * Build the management route handler.
 *
 * @param {object} options Wiring.
 * @param {() => string[]} options.getRoots Current roots, in configured order.
 * @param {(roots: string[]) => Promise<{restartRequired: boolean}>} options.setRoots Persist a new root list.
 * @param {(reason: string) => void} [options.rescan] Trigger a reconciliation pass.
 * @param {() => Promise<object|undefined>} [options.distill] Trigger one distillation pass.
 * @param {() => object} [options.distillStatus] Report distillation settings and progress.
 * @param {() => Promise<object[]>} [options.listModels] The composer's live model list.
 * @param {() => object|null} [options.getModel] Current distillation model selection.
 * @param {(selection: object|null) => object} [options.setModel] Persist a selection.
 * @param {(enabled: boolean) => object} [options.setDistillEnabled] Flip distillation on/off live.
 * @param {(req: import('node:http').IncomingMessage) => number | undefined} [options.reject] Trust fence.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} Handler.
 */
export function createHandler({
  getRoots, setRoots, rescan, distill, distillStatus,
  listModels, getModel, setModel, setDistillEnabled, reject,
}) {
  return async (req, res) => {
    const rejection = reject === undefined ? undefined : reject(req)
    if (rejection !== undefined) {
      res.writeHead(rejection)
      res.end()
      return
    }

    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname.slice(ROUTE_PREFIX.length) || '/'

    try {
      if (path === '/' || path === '/state') {
        if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
        const roots = getRoots()
        sendJson(res, 200, {
          roots: roots.map((root) => ({
            path: root,
            exists: existsSync(root),
            markdown: existsSync(root) ? countMarkdown(root) : 0,
          })),
          ...describeStore(),
          // Distillation is a separate sink with separate health: report it even
          // when disabled, so "no insights appeared" is distinguishable from
          // "the sidecar never ran".
          ...(typeof distillStatus === 'function' ? { distill: distillStatus() } : {}),
        })
        return
      }

      if (path === '/roots') {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        const body = JSON.parse(await readBody(req))
        const verdict = validateRoot(body?.root)
        if (!verdict.ok) { sendJson(res, 400, { code: 'invalid-root', message: verdict.reason }); return }
        const current = getRoots()
        if (current.some((root) => resolve(root) === verdict.root)) {
          sendJson(res, 409, { code: 'duplicate-root', message: 'already watched' })
          return
        }
        const next = [...current, verdict.root]
        const result = await setRoots(next)
        sendJson(res, 200, { roots: next, ...result })
        return
      }

      if (path === '/roots/remove') {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        const body = JSON.parse(await readBody(req))
        if (typeof body?.root !== 'string') {
          sendJson(res, 400, { code: 'invalid-root', message: 'root must be a string' })
          return
        }
        const target = resolve(body.root)
        const current = getRoots()
        const next = current.filter((root) => resolve(root) !== target)
        if (next.length === current.length) {
          sendJson(res, 404, { code: 'unknown-root', message: 'not watched' })
          return
        }
        const result = await setRoots(next)
        sendJson(res, 200, { roots: next, ...result })
        return
      }

      // POST /enabled - flip the distillation switch immediately. The Host keeps
      // a live in-memory value, so no restart is needed; the choice is also
      // written to the profile patch so it survives one.
      if (path === '/enabled') {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        if (typeof setDistillEnabled !== 'function') {
          sendJson(res, 501, { code: 'switch-unavailable', message: 'distill switch is not wired' })
          return
        }
        const body = JSON.parse(await readBody(req))
        if (typeof body?.enabled !== 'boolean') {
          sendJson(res, 400, { code: 'invalid-enabled', message: 'enabled must be a boolean' })
          return
        }
        const result = setDistillEnabled(body.enabled)
        sendJson(res, 200, {
          ...result,
          enabled: body.enabled,
          status: typeof distillStatus === 'function' ? distillStatus() : undefined,
        })
        return
      }

      // GET /models  - the SAME catalog the main composer's model picker uses.
      // POST /model   - persist the user's choice; body is { value } where value
      //                 is JSON.stringify([provider, model]), or null to clear.
      if (path === '/models') {
        if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
        if (typeof listModels !== 'function') {
          sendJson(res, 501, { code: 'models-unavailable', message: 'model catalog is not wired' })
          return
        }
        const models = await listModels()
        sendJson(res, 200, {
          models,
          selected: typeof getModel === 'function' ? getModel() : null,
        })
        return
      }

      if (path === '/model') {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        if (typeof setModel !== 'function') {
          sendJson(res, 501, { code: 'model-unavailable', message: 'model selection is not wired' })
          return
        }
        const body = JSON.parse(await readBody(req))
        const value = body?.value ?? null
        let selection = null
        if (value !== null) {
          const pair = JSON.parse(String(value))
          if (!Array.isArray(pair) || pair.length !== 2
            || typeof pair[0] !== 'string' || typeof pair[1] !== 'string') {
            sendJson(res, 400, { code: 'invalid-model', message: 'value must be [provider, model]' })
            return
          }
          selection = { provider: pair[0], model: pair[1] }
        }
        const result = setModel(selection)
        sendJson(res, 200, {
          ...result,
          selected: selection,
          status: typeof distillStatus === 'function' ? distillStatus() : undefined,
        })
        return
      }

      if (path === '/distill') {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        if (typeof distill !== 'function') {
          sendJson(res, 501, { code: 'distill-unavailable', message: 'distillation is not wired' })
          return
        }
        const report = await distill()
        sendJson(res, 200, {
          report: report ?? null,
          status: typeof distillStatus === 'function' ? distillStatus() : undefined,
        })
        return
      }

      if (path === '/rescan') {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        if (rescan !== undefined) rescan('manual')
        sendJson(res, 200, { ok: true })
        return
      }

      sendJson(res, 404, { code: 'not-found', message: 'no route for ' + path })
    } catch (error) {
      const code = error?.code === 'too-large' ? 413 : 500
      sendJson(res, code, {
        code: error?.code === 'too-large' ? 'body-too-large' : 'internal-error',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
}