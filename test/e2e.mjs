import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from '../lib/index.js'

const base = mkdtempSync(join(tmpdir(), 'e2e-'))
const kb = join(base, 'kb')
const store = join(base, 'store')
mkdirSync(kb, { recursive: true })
mkdirSync(store, { recursive: true })

const logs = []
const ctx = { effect: (fn) => { ctx._dispose = fn() } }
apply(ctx, { roots: [kb], storeDirectory: store, debounceMs: 150, minBytes: 10, log: (m) => logs.push(m) })

const write = (name, body) => {
  const abs = join(kb, name)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, body, 'utf8')
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const idx = () => JSON.parse(readFileSync(join(store, 'index.json'), 'utf8'))

const LONG = '这是用于端到端验证的正文内容，需要足够长才能通过最小字节检查。'.repeat(10)

write('note-a.md', LONG)
write('sub/note-b.md', LONG)
await sleep(900)
console.log('after create:', idx().documents.length, 'records')

write('note-a.md', LONG + ' 修改后的内容')
await sleep(900)
const rec = idx().documents.find((d) => d.title.includes('note-a'))
console.log('after edit: revision =', rec.revision)

rmSync(join(kb, 'sub/note-b.md'))
await sleep(900)
console.log('after delete (prune off):', idx().documents.filter(d=>d.status==='active').length, 'active')

console.log('logs:', JSON.stringify(logs, null, 1))
ctx._dispose && ctx._dispose()