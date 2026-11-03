import { createServer } from 'node:http'
import { createHandler, ROUTE_PREFIX } from '../lib/server.js'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const base = mkdtempSync(join(tmpdir(), 'route-'))
const kb1 = join(base, 'kb1'); mkdirSync(kb1); writeFileSync(join(kb1, 'a.md'), 'x'.repeat(300))
const kb2 = join(base, 'kb2'); mkdirSync(kb2); writeFileSync(join(kb2, 'b.md'), 'x'.repeat(300))
const patch = join(base, 'cordis.patch.yml')
writeFileSync(patch, '- id: mnemon-sync-monitor\n  name: dsh-mnemon-sync-monitor\n  config:\n    enabled: true\n    roots: []\n', 'utf8')

let roots = []
let writes = 0
const handler = createHandler({
  getRoots: () => [...roots],
  setRoots: async (next) => { roots = next; writes++; return { restartRequired: false, changed: true } },
  rescan: () => {},
  reject: () => undefined,
})

const server = createServer((req, res) => handler(req, res))
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const baseUrl = 'http://127.0.0.1:' + port + ROUTE_PREFIX

const call = async (path, init) => {
  const res = await fetch(baseUrl + path, { headers: { 'content-type': 'application/json' }, ...init })
  return { status: res.status, body: await res.json() }
}

console.log('GET /state        ->', (await call('/state')).status, JSON.stringify((await call('/state')).body.roots))
const add1 = await call('/roots', { method: 'POST', body: JSON.stringify({ root: kb1 }) })
console.log('POST /roots       ->', add1.status, 'roots:', add1.body.roots.length)
const add2 = await call('/roots', { method: 'POST', body: JSON.stringify({ root: kb2 }) })
console.log('POST /roots #2    ->', add2.status, 'roots:', add2.body.roots.length)

const state = await call('/state')
console.log('GET /state        -> roots with md counts:', JSON.stringify(state.body.roots.map(r => [r.path.split('\\').pop(), r.markdown])))

const dup = await call('/roots', { method: 'POST', body: JSON.stringify({ root: kb1 }) })
console.log('POST duplicate    ->', dup.status, dup.body.code)

const bad = await call('/roots', { method: 'POST', body: JSON.stringify({ root: join(base, 'nope') }) })
console.log('POST missing dir  ->', bad.status, bad.body.code)

const rm = await call('/roots/remove', { method: 'POST', body: JSON.stringify({ root: kb1 }) })
console.log('POST /roots/remove->', rm.status, 'roots:', rm.body.roots.length)

const rm2 = await call('/roots/remove', { method: 'POST', body: JSON.stringify({ root: kb1 }) })
console.log('remove unknown    ->', rm2.status, rm2.body.code)

const scan = await call('/rescan', { method: 'POST' })
console.log('POST /rescan      ->', scan.status)

const nf = await call('/nope')
console.log('GET /nope         ->', nf.status, nf.body.code)

console.log('setRoots calls:', writes)
const check = await call('/state')
console.log('final roots:', check.body.roots.length)
server.close()
