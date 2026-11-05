import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  readDistillEffort, writeDistillEffort, readDistillEnabled, writeDistillEnabled,
  DEFAULT_DISTILL_EFFORT, DISTILL_EFFORTS,
} from '../lib/persist.js'

/** Create a patch file with a plugin row that already carries a distill block. */
function patchWithDistill(extra = []) {
  const base = mkdtempSync(join(tmpdir(), 'effort-'))
  const path = join(base, 'cordis.patch.yml')
  writeFileSync(path, [
    '# profile patch',
    '- id: other',
    '  name: other',
    '  config:',
    '    keep: true',
    '',
    '- id: mnemon-sync-monitor',
    '  name: dsh-mnemon-sync-monitor',
    '  config:',
    '    enabled: true',
    '    roots: []',
    '    distill:',
    '      enabled: true',
    ...extra,
    '',
    '- id: trailing',
    '  name: tail',
    '',
  ].join('\n'), 'utf8')
  return path
}

test('the default effort is low, not the model default', () => {
  // The whole point of this setting: distillation must not inherit a model's
  // expensive default. 'high' here would silently restore the old behaviour.
  assert.equal(DEFAULT_DISTILL_EFFORT, 'low')
  assert.ok(DISTILL_EFFORTS.includes(DEFAULT_DISTILL_EFFORT))
})

test('readDistillEffort reports absence rather than guessing', () => {
  const path = patchWithDistill()
  // Absent means "no override", which is a real choice and differs from 'off'.
  assert.equal(readDistillEffort(path), undefined)
})

test('writeDistillEffort inserts inside the distill block', () => {
  const path = patchWithDistill()
  const result = writeDistillEffort(path, 'low')
  assert.equal(result.changed, true)
  assert.equal(readDistillEffort(path), 'low')

  const text = readFileSync(path, 'utf8')
  // Must be nested under distill:, not a top-level key: the Host reads config
  // from the nested block, so a top-level key would silently never apply.
  const lines = text.split('\n')
  const at = lines.findIndex((line) => /\s*reasoningEffort:/.test(line))
  assert.ok(at > 0)
  assert.ok(lines[at].startsWith('      '), 'expected nested indentation, got: ' + lines[at])
  // The surrounding document survives byte for byte.
  assert.ok(text.includes('# profile patch'))
  assert.ok(text.includes('    keep: true'))
  assert.ok(text.includes('  enabled: true'))
  assert.ok(text.includes('- id: trailing'))
})

test('writeDistillEffort replaces an existing key in place', () => {
  const path = patchWithDistill(['      reasoningEffort: low'])
  assert.equal(readDistillEffort(path), 'low')
  const result = writeDistillEffort(path, 'high')
  assert.equal(result.changed, true)
  assert.equal(readDistillEffort(path), 'high')
  // One key, not two.
  const text = readFileSync(path, 'utf8')
  assert.equal((text.match(/reasoningEffort:/g) || []).length, 1)
})

test('writeDistillEffort is a no-op when the value already matches', () => {
  const path = patchWithDistill(['      reasoningEffort: high'])
  const before = readFileSync(path, 'utf8')
  const result = writeDistillEffort(path, 'high')
  assert.equal(result.changed, false)
  assert.equal(readFileSync(path, 'utf8'), before)
})

test('null clears the override instead of writing a bare key', () => {
  const path = patchWithDistill(['      reasoningEffort: low'])
  const result = writeDistillEffort(path, null)
  assert.equal(result.changed, true)
  assert.equal(readDistillEffort(path), undefined)
  const text = readFileSync(path, 'utf8')
  // A bare 'reasoningEffort:' would parse as null and be indistinguishable from
  // a value the reader cannot understand; the line must be gone entirely.
  assert.ok(!/reasoningEffort/.test(text))
})

test('clearing an absent effort changes nothing', () => {
  const path = patchWithDistill()
  assert.equal(writeDistillEffort(path, null).changed, false)
})

test('writeDistillEffort creates the distill block when absent', () => {
  const base = mkdtempSync(join(tmpdir(), 'effort2-'))
  const path = join(base, 'cordis.patch.yml')
  writeFileSync(path, [
    '- id: mnemon-sync-monitor',
    '  name: dsh-mnemon-sync-monitor',
    '  config:',
    '    enabled: true',
    '',
  ].join('\n'), 'utf8')

  const result = writeDistillEffort(path, 'low')
  assert.equal(result.changed, true)
  assert.equal(result.created, true)
  assert.equal(readDistillEffort(path), 'low')
  // The switch must still have somewhere to live: a created block carries both.
  assert.equal(readDistillEnabled(path), false)
})

test('writeDistillEffort rejects an empty effort', () => {
  const path = patchWithDistill()
  assert.throws(() => writeDistillEffort(path, ''), /non-empty string or null/)
  assert.throws(() => writeDistillEffort(path, '   '), /non-empty string or null/)
})

test('effort and enabled do not overwrite each other', () => {
  const path = patchWithDistill()
  writeDistillEffort(path, 'low')
  writeDistillEnabled(path, false)
  assert.equal(readDistillEffort(path), 'low')
  assert.equal(readDistillEnabled(path), false)

  writeDistillEnabled(path, true)
  assert.equal(readDistillEffort(path), 'low')
  assert.equal(readDistillEnabled(path), true)
})

test('effort survives a CRLF patch file', () => {
  const base = mkdtempSync(join(tmpdir(), 'effort3-'))
  const path = join(base, 'cordis.patch.yml')
  writeFileSync(path, [
    '- id: mnemon-sync-monitor',
    '  name: dsh-mnemon-sync-monitor',
    '  config:',
    '    enabled: true',
    '    distill:',
    '      enabled: true',
    '',
  ].join('\r\n'), 'utf8')

  writeDistillEffort(path, 'low')
  assert.equal(readDistillEffort(path), 'low')
  const text = readFileSync(path, 'utf8')
  // The file's own line ending must be preserved: mixing them makes the whole
  // profile patch hard to diff even though YAML accepts it.
  assert.ok(!/[^\r]\n/.test(text), 'expected every LF to be part of a CRLF pair')
})
