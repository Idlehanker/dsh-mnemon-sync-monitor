import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeRoots, writeDistillEnabled, readDistillEnabled, readRoots } from '../lib/persist.js'

/** Write a patch file and return its path. */
function patch(content, eol) {
  const base = mkdtempSync(join(tmpdir(), 'persist-edge-'))
  const path = join(base, 'cordis.patch.yml')
  writeFileSync(path, content.split('\n').join(eol ?? '\n'), 'utf8')
  return path
}

const ROW_NO_ROOTS = [
  '- id: mnemon-sync-monitor',
  '  name: dsh-mnemon-sync-monitor',
  '  config:',
  '    enabled: true',
  '    limitBytes: 33554432',
  '- id: other',
  '  config:',
  '    enabled: true',
  '',
].join('\n')

// ------------------------------------------------------- roots insertion

test('writeRoots inserts the roots key inside the config block', () => {
  const path = patch(ROW_NO_ROOTS)
  writeRoots(path, ['C:\\vault'])
  const lines = readFileSync(path, 'utf8').split('\n')
  const configAt = lines.findIndex((l) => /^\s*config:\s*$/u.test(l))
  const rootsAt = lines.findIndex((l) => /^\s*roots:/u.test(l))
  assert.ok(configAt >= 0, 'config block must still exist')
  assert.ok(rootsAt > configAt, 'roots must come after config, not before it')
  assert.deepEqual(readRoots(path), ['C:\\vault'])
})

test('writeRoots does not put the roots key before name', () => {
  const path = patch(ROW_NO_ROOTS)
  writeRoots(path, ['C:\\vault'])
  const lines = readFileSync(path, 'utf8').split('\n')
  const nameAt = lines.findIndex((l) => /^\s*name:/u.test(l))
  const rootsAt = lines.findIndex((l) => /^\s*roots:/u.test(l))
  assert.ok(rootsAt > nameAt, 'roots must not precede name')
})

// --------------------------------------------------------------- EOL safety

test('writeRoots preserves CRLF line endings', () => {
  const path = patch(ROW_NO_ROOTS, '\r\n')
  writeRoots(path, ['C:\\vault'])
  const text = readFileSync(path, 'utf8')
  const bareLf = (text.match(/[^\r]\n/gu) || []).length
  assert.equal(bareLf, 0, 'no bare LF may survive in a CRLF file')
  assert.ok((text.match(/\r\n/gu) || []).length > 0)
  assert.deepEqual(readRoots(path), ['C:\\vault'])
})

test('writeRoots preserves LF line endings', () => {
  const path = patch(ROW_NO_ROOTS, '\n')
  writeRoots(path, ['C:\\vault'])
  const text = readFileSync(path, 'utf8')
  assert.equal((text.match(/\r\n/gu) || []).length, 0)
})

// ------------------------------------------------------ nested row lookup

test('a row nested under insert: is edited in place, not duplicated', () => {
  const path = patch([
    '- insert:',
    '    - id: mnemon-sync-monitor',
    '      name: dsh-mnemon-sync-monitor',
    '      config:',
    '        enabled: true',
    '        roots: []',
    '- id: other',
    '  config:',
    '    enabled: true',
    '',
  ].join('\n'))
  writeRoots(path, ['C:\\vault'])
  const text = readFileSync(path, 'utf8')
  const rows = (text.match(/id:\s*mnemon-sync-monitor/gu) || []).length
  assert.equal(rows, 1, 'the row must be edited in place')
  assert.deepEqual(readRoots(path), ['C:\\vault'])
})

// ------------------------------------------------- distill block creation

test('writeDistillEnabled creates the distill block when it is absent', () => {
  const path = patch([
    '- id: mnemon-sync-monitor',
    '  name: dsh-mnemon-sync-monitor',
    '  config:',
    '    enabled: true',
    '- id: other',
    '  config:',
    '    enabled: true',
    '',
  ].join('\n'))
  const result = writeDistillEnabled(path, true)
  assert.equal(result.changed, true)
  assert.equal(readDistillEnabled(path), true)
  const text = readFileSync(path, 'utf8')
  assert.ok(/^\s*distill:\s*$/mu.test(text), 'a distill block must exist')
})

test('writeDistillEnabled does not disturb the top-level enabled key', () => {
  const path = patch([
    '- id: mnemon-sync-monitor',
    '  name: dsh-mnemon-sync-monitor',
    '  config:',
    '    enabled: true',
    '    distill:',
    '      enabled: false',
    '',
  ].join('\n'))
  writeDistillEnabled(path, true)
  const lines = readFileSync(path, 'utf8').split('\n')
  const top = lines.find((l) => /^    enabled:/u.test(l))
  assert.equal(top, '    enabled: true', 'the watcher master switch must not move')
  assert.equal(readDistillEnabled(path), true)
})
