import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeRoots } from '../lib/persist.js'
import { validateRoot, countMarkdown } from '../lib/server.js'

/** Create a patch file with a plugin row. */
function patchWith(content) {
  const base = mkdtempSync(join(tmpdir(), 'persist-'))
  const path = join(base, 'cordis.patch.yml')
  writeFileSync(path, content, 'utf8')
  return path
}

const BASE = [
  '# profile patch',
  '- id: something-else',
  '  name: other',
  '  config:',
  '    keep: true',
  '',
  '- id: mnemon-sync-monitor',
  '  name: dsh-mnemon-sync-monitor',
  '  config:',
  '    enabled: true',
  '    roots:',
  '      - C:\\old\\one',
  '    debounceMs: 1200',
  '',
  '- id: trailing',
  '  name: tail',
  '',
].join('\n')

test('writeRoots replaces only the roots block', () => {
  const path = patchWith(BASE)
  writeRoots(path, ['C:\\new\\a', 'C:\\new\\b'])
  const text = readFileSync(path, 'utf8')
  // Paths are JSON-quoted because a Windows path needs escaping in YAML.
  assert.ok(text.includes('C:'))
  assert.ok(text.includes('new'))
  assert.ok(!text.includes('old'))
  // Everything else survives, including comments and the neighbouring rows.
  assert.ok(text.includes('# profile patch'))
  assert.ok(text.includes('    keep: true'))
  assert.ok(text.includes('  debounceMs: 1200'))
  assert.ok(text.includes('- id: trailing'))
})

test('writeRoots reports no change when roots are equal', () => {
  const path = patchWith(BASE)
  const first = writeRoots(path, ['C:\\new\\a'])
  assert.equal(first.changed, true)
  const second = writeRoots(path, ['C:\\new\\a'])
  assert.equal(second.changed, false)
})

test('writeRoots appends a block when the row is absent', () => {
  const path = patchWith('# empty\n- id: other\n  name: other\n')
  writeRoots(path, ['C:\\x'])
  const text = readFileSync(path, 'utf8')
  assert.ok(text.includes('- id: mnemon-sync-monitor'))
  assert.ok(text.includes('C:\\\\x') || text.includes('C:\\x'))
  assert.ok(text.includes('- id: other'))
})

test('writeRoots handles removing every root', () => {
  const path = patchWith(BASE)
  writeRoots(path, [])
  const text = readFileSync(path, 'utf8')
  assert.ok(text.includes('roots: []'))
  assert.ok(!text.includes('C:\\old\\one'))
})

test('validateRoot rejects missing paths and files', () => {
  assert.equal(validateRoot('').ok, false)
  assert.equal(validateRoot('C:\\definitely\\not\\here\\at\\all').ok, false)
  assert.equal(validateRoot(undefined).ok, false)
})

test('validateRoot accepts an existing directory', () => {
  const base = mkdtempSync(join(tmpdir(), 'vroot-'))
  const verdict = validateRoot(base)
  assert.equal(verdict.ok, true)
})

test('countMarkdown counts nested files and skips excluded dirs', () => {
  const base = mkdtempSync(join(tmpdir(), 'count-'))
  writeFileSync(join(base, 'a.md'), 'x')
  writeFileSync(join(base, 'b.txt'), 'x')
  const nested = join(base, 'sub')
  mkdirSync(nested)
  writeFileSync(join(nested, 'c.md'), 'x')
  const git = join(base, '.git')
  mkdirSync(git)
  writeFileSync(join(git, 'd.md'), 'x')
  assert.equal(countMarkdown(base), 2)
})