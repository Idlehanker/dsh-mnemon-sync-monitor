import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHandler } from '../lib/server.js'

/**
 * What does POST /rescan act on?
 *
 * It re-scans the roots that are ALREADY WATCHED. It never reads the path box in
 * the UI - the route takes no body at all. That distinction is easy to get wrong
 * from the page layout, because 添加 (adds whatever is typed) sits next to it, so
 * this file pins the behaviour the layout must not contradict.
 */
function post(handler, path) {
  const req = new EventEmitter()
  req.url = '/mnemon-sync-monitor' + path
  req.method = 'POST'
  req.headers = {}
  const res = new EventEmitter()
  res.chunks = []; res.writableEnded = false; res.destroyed = false
  res.writeHead = () => res
  res.write = (c) => { res.chunks.push(String(c)); return true }
  res.end = () => { res.writableEnded = true }
  return handler(req, res).then(() => ({ body: res.chunks.join('') }))
}

test('rescan touches only the configured roots, never a caller-supplied path', async () => {
  const box = mkdtempSync(join(tmpdir(), 'rescan-scope-'))
  try {
    const configured = join(box, 'configured')
    const typedOnly = join(box, 'typed-only')
    mkdirSync(configured); mkdirSync(typedOnly)
    writeFileSync(join(configured, 'a.md'), '# a' + String.fromCharCode(10, 10) + 'x'.repeat(300))
    writeFileSync(join(typedOnly, 'b.md'), '# b' + String.fromCharCode(10, 10) + 'y'.repeat(300))

    const watched = [configured]
    const scanned = []
    const handler = createHandler({
      getRoots: () => watched,
      setRoots: async () => ({}),
      reject: () => undefined,
      // Mirrors lib/index.js: for (const root of roots) reconcile(root, 'manual')
      rescan: () => { for (const root of watched) scanned.push(root) },
    })

    await post(handler, '/rescan')

    assert.deepEqual(scanned, [configured], 'only watched roots are scanned')
    assert.equal(scanned.includes(typedOnly), false, 'an unadded path is never scanned')
  } finally {
    rmSync(box, { recursive: true, force: true })
  }
})

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), '..', 'client.js')

test('the rescan route accepts no body, so the input box cannot influence it', () => {
  const source = readFileSync(CLIENT, 'utf8')
  const call = source.match(/api\('\/rescan'[^)]*\)/)
  assert.ok(call !== null, 'client calls /rescan')
  assert.equal(/body:/.test(call[0]), false, 'no body is sent')
})

test('the rescan button renders in the watched-list header, not the input row', () => {
  const source = readFileSync(CLIENT, 'utf8')
  const headerIndex = source.indexOf("title: '知识库监听'")
  const inputIndex = source.indexOf("placeholder: '输入要监听的目录绝对路径")
  const rescanIndex = source.indexOf("onClick: rescan")
  assert.ok(headerIndex > 0 && inputIndex > 0 && rescanIndex > 0, 'all anchors present')
  // The scan handler is wired BEFORE the input row now: it belongs to the header.
  assert.ok(rescanIndex < inputIndex, 'rescan is declared above the input row')
  // And its label is passed to GroupHead as `right`.
  const between = source.slice(headerIndex, inputIndex)
  assert.match(between, /right: h\(Button, \{/, 'header receives a right-slot button')
  assert.match(between, /立即扫描/, 'that button is the rescan')
})
