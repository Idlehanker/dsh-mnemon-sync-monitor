import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { canonicalRoots, findRootConflict, isInsideRoot, rootKey } from '../lib/roots.js'
import { createHandler } from '../lib/server.js'

/** A throwaway directory tree, so root paths are real and platform-native. */
const created = []
function tree(names) {
  const base = mkdtempSync(join(tmpdir(), 'roots-'))
  created.push(base)
  for (const name of names) mkdirSync(join(base, name), { recursive: true })
  return base
}

// Only the directories this file made: never the shared temp root itself.
test.after(() => {
  for (const base of created.splice(0)) rmSync(base, { recursive: true, force: true })
})

// ------------------------------------------------------------------- keys

test('rootKey folds case and trailing separators, but only for comparison', () => {
  const base = tree(['Vault'])
  const plain = resolve(base, 'Vault')
  assert.equal(rootKey(plain + sep), rootKey(plain))
  assert.equal(rootKey(plain + sep + sep), rootKey(plain))
  // Case folding is platform policy, not a guess: compare against itself folded.
  const upper = plain.toUpperCase()
  const lowered = ['win32', 'darwin'].includes(process.platform)
  assert.equal(rootKey(upper) === rootKey(plain), lowered)
})

test('isInsideRoot compares whole segments, not string prefixes', () => {
  const base = tree(['vault', 'vault2'])
  const vault = join(base, 'vault')
  const vault2 = join(base, 'vault2')
  const inner = join(vault, 'inner')
  mkdirSync(inner, { recursive: true })

  assert.equal(isInsideRoot(inner, vault), true)
  assert.equal(isInsideRoot(vault2, vault), false, '/vault2 is not inside /vault')
  assert.equal(isInsideRoot(vault, vault), false, 'a root is not inside itself')
  assert.equal(isInsideRoot(vault, inner), false)
})

// --------------------------------------------------------------- canonical

test('canonicalRoots drops a nested root in favour of its ancestor', () => {
  const base = tree(['vault', join('vault', 'inner')])
  const vault = join(base, 'vault')
  const inner = join(vault, 'inner')

  const result = canonicalRoots([vault, inner])
  assert.deepEqual(result.roots, [vault])
  assert.equal(result.dropped.length, 1)
  assert.equal(result.dropped[0].root, inner)
  assert.equal(result.dropped[0].owner, vault)
  assert.equal(result.dropped[0].relation, 'inside')
})

test('canonicalRoots is order-independent: the ancestor wins either way', () => {
  const base = tree(['vault', join('vault', 'inner')])
  const vault = join(base, 'vault')
  const inner = join(vault, 'inner')

  assert.deepEqual(canonicalRoots([inner, vault]).roots, [vault])
  assert.deepEqual(canonicalRoots([vault, inner]).roots, [vault])
})

test('canonicalRoots folds an exact duplicate to one root', () => {
  const base = tree(['vault'])
  const vault = join(base, 'vault')
  const result = canonicalRoots([vault, vault + sep])
  assert.deepEqual(result.roots, [vault])
  assert.equal(result.dropped.length, 1)
  assert.equal(result.dropped[0].relation, 'duplicate')
})

test('canonicalRoots keeps disjoint siblings, and their configured order', () => {
  const base = tree(['b', 'a'])
  const a = join(base, 'a')
  const b = join(base, 'b')
  // Not sorted: that order is what the page lists and the budget cycles through.
  assert.deepEqual(canonicalRoots([b, a]).roots, [b, a])
})

test('canonicalRoots survives empty and malformed input', () => {
  assert.deepEqual(canonicalRoots([]).roots, [])
  assert.deepEqual(canonicalRoots(undefined).roots, [])
  assert.deepEqual(canonicalRoots(['', '   ', null]).roots, [])
})

test('canonicalRoots does not merge two vaults whose names merely share a prefix', () => {
  const base = tree(['vault', 'vault2'])
  const vault = join(base, 'vault')
  const vault2 = join(base, 'vault2')
  const result = canonicalRoots([vault, vault2])
  assert.deepEqual(result.roots, [vault, vault2])
  assert.deepEqual(result.dropped, [])
})

// ---------------------------------------------------------------- conflict

test('findRootConflict describes same, inside and contains', () => {
  const base = tree(['vault', join('vault', 'inner')])
  const vault = join(base, 'vault')
  const inner = join(vault, 'inner')

  assert.equal(findRootConflict(vault, [vault]).relation, 'same')
  assert.equal(findRootConflict(inner, [vault]).relation, 'inside')
  assert.equal(findRootConflict(vault, [inner]).relation, 'contains')
  assert.equal(findRootConflict(inner, [join(base, 'other')]), undefined)
})

// ------------------------------------------------------------------ route

function bufferedRequest({ path, method = 'GET', body }) {
  const req = new EventEmitter()
  req.method = method
  req.url = '/mnemon-sync-monitor' + path
  req.headers = { host: '127.0.0.1' }
  return { req, body }
}

function callRoute(handler, { path, method = 'GET', body }) {
  const { req, body: payload } = bufferedRequest({ path, method, body })
  const res = { status: 0, chunks: [], headers: {}, writableEnded: false }
  res.setHeader = (key, value) => { res.headers[key] = value }
  res.writeHead = (status) => { res.status = status; return res }
  res.end = (chunk) => { if (chunk !== undefined) res.chunks.push(String(chunk)); res.writableEnded = true }
  res.body = () => {
    const text = res.chunks.join('')
    try { return JSON.parse(text) } catch { return text }
  }
  const pending = handler(req, res)
  if (payload !== undefined) {
    setImmediate(() => {
      req.emit('data', Buffer.from(JSON.stringify(payload)))
      req.emit('end')
    })
  }
  return pending.then(() => ({ status: res.status, body: res.body() }))
}

test('POST /roots refuses a root nested inside a watched one', async () => {
  const base = tree(['vault', join('vault', 'inner')])
  const vault = join(base, 'vault')
  const inner = join(vault, 'inner')
  let written
  const handler = createHandler({
    getRoots: () => [vault],
    setRoots: async (next) => { written = next; return {} },
    reject: () => undefined,
  })
  const result = await callRoute(handler, { path: '/roots', method: 'POST', body: { root: inner } })
  assert.equal(result.status, 409)
  assert.equal(result.body.code, 'overlapping-root')
  assert.equal(result.body.relation, 'inside')
  assert.match(result.body.message, /already watched/u)
  assert.equal(written, undefined, 'a refused root must never reach the writer')
})

test('POST /roots refuses a root that contains a watched one', async () => {
  const base = tree(['vault', join('vault', 'inner')])
  const vault = join(base, 'vault')
  const inner = join(vault, 'inner')
  let written
  const handler = createHandler({
    getRoots: () => [inner],
    setRoots: async (next) => { written = next; return {} },
    reject: () => undefined,
  })
  const result = await callRoute(handler, { path: '/roots', method: 'POST', body: { root: vault } })
  assert.equal(result.status, 409)
  assert.equal(result.body.code, 'overlapping-root')
  assert.equal(result.body.relation, 'contains')
  assert.equal(written, undefined)
})

test('POST /roots still reports an exact duplicate with its own code', async () => {
  const base = tree(['vault'])
  const vault = join(base, 'vault')
  const handler = createHandler({
    getRoots: () => [vault],
    setRoots: async () => ({}),
    reject: () => undefined,
  })
  const result = await callRoute(handler, { path: '/roots', method: 'POST', body: { root: vault } })
  assert.equal(result.status, 409)
  assert.equal(result.body.code, 'duplicate-root')
})

test('POST /roots accepts a genuinely disjoint root', async () => {
  const base = tree(['a', 'b'])
  const a = join(base, 'a')
  const b = join(base, 'b')
  let written
  const handler = createHandler({
    getRoots: () => [a],
    setRoots: async (next) => { written = next; return { changed: true } },
    reject: () => undefined,
  })
  const result = await callRoute(handler, { path: '/roots', method: 'POST', body: { root: b } })
  assert.equal(result.status, 200)
  assert.deepEqual(written, [a, b])
})
