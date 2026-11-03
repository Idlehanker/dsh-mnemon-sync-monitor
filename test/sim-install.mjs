import { apply } from '../lib/index.js'
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const store = mkdtempSync(join(tmpdir(), 'sim-'))
mkdirSync(store, { recursive: true })
const logs = []
const ctx = { effect: (fn) => { ctx._dispose = fn() } }

apply(ctx, {
  roots: [
    'C:\\OneDrive\\iNote-OneDrive',
    'C:\\Users\\hzuju\\LogseqGithub\\pages',
    'C:\\Users\\hzuju\\LogseqGithub\\journals',
  ],
  storeDirectory: store,
  debounceMs: 1200,
  minBytes: 200,
  prune: false,
  dryRun: false,
  log: (m) => logs.push(m),
})

// startup reconciliation is synchronous inside apply
const idx = JSON.parse(readFileSync(join(store, 'index.json'), 'utf8'))
console.log('=== startup reconciliation ===')
console.log('records created:', idx.documents.length)
console.log('logs:')
for (const l of logs) console.log('  ' + l)

const byRoot = new Map()
for (const d of idx.documents) {
  const sp = d.sourcePaths[0]
  const root = sp.split('\u0000')[0]
  byRoot.set(root, (byRoot.get(root) ?? 0) + 1)
}
console.log('\n=== records by owning root ===')
for (const [r, n] of byRoot) console.log('  ' + n + '  ' + r)
ctx._dispose && ctx._dispose()
