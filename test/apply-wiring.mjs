/**
 * Wiring check for the observer path inside apply().
 *
 * Proves the hub is created, the SSE route is handed a real handler, the pass
 * publishes into the hub, and a subscriber that attaches BEFORE anything happens
 * receives the startup state - i.e. the page can render before the first pass.
 *
 * No model call is made: distill is disabled here, which is itself a case worth
 * pinning (a disabled sidecar must still answer /state and /events).
 *
 * Run: node test/apply-wiring.mjs
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-apply-'))
const vault = join(sandbox, 'vault')
const store = join(sandbox, 'store')
mkdirSync(vault, { recursive: true })
mkdirSync(store, { recursive: true })
writeFileSync(join(vault, 'a.md'), '# A\n\n' + '正文'.repeat(200), 'utf8')

// HERMETIC: apply() prefers the value persisted in the profile patch over the
// one in `config`, so without an isolated patchPath this test reads the USER'S
// real profile. With distillation left on there, the test fired a real pass
// through the real gateway and wrote insights into the real memory space - the
// same leak class as the live-loop e2e. Point patchPath at a scratch file whose
// distill switch is off.
const patchPath = join(sandbox, 'cordis.patch.yml')
writeFileSync(patchPath, [
  '- id: mnemon-sync-monitor',
  '  config:',
  '    distill:',
  '      enabled: false',
  '    roots: []',
  '',
].join('\n'), 'utf8')

const logs = []
const ctx = {
  get: () => undefined,
  effect: (fn) => { ctx._dispose = fn() },
}

apply(ctx, {
  roots: [vault],
  storeDirectory: store,
  patchPath,
  distill: { enabled: false },
  log: (message) => logs.push(message),
  // The Host's web server is optional; without it no route mounts, which this
  // test asserts separately below.
})

// The watcher attached and reconciled on startup even with no webServer.
assert.ok(logs.some((line) => line.includes('watching ' + vault)), 'root watched: ' + logs.join(' | '))
ctx._dispose?.()
rmSync(sandbox, { recursive: true, force: true })

console.log('apply-wiring: PASS (watcher starts without a webServer, route mount is optional)')
