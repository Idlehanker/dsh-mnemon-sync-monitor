import { planSync, collectMarkdown } from '../lib/index.js'
import { DocumentsStore } from '../lib/store.js'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const KB = process.argv[2] ?? process.env.KB_ROOT
if (!KB) {
  console.error('usage: node test/live.mjs <knowledge-base-root>')
  process.exit(2)
}

const store = mkdtempSync(join(tmpdir(), 'live-'))
mkdirSync(store, { recursive: true })

console.log('scanning knowledge base:', KB)
const files = collectMarkdown(KB)
console.log('markdown files found:', files.length)

const documents = new DocumentsStore(store)
const plan = planSync({ root: KB, index: documents.readIndex(), minBytes: 200, prune: false })
console.log('plan -> create:', plan.create.length, '| update:', plan.update.length, '| archive:', plan.archive.length)

const started = Date.now()
const counts = documents.apply(plan)
console.log('applied in', Date.now() - started, 'ms ->', JSON.stringify(counts))
console.log('store records:', documents.readIndex().documents.length)
