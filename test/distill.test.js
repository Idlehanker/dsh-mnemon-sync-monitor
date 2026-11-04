import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readRoots, writeRoots, readDistillModel, writeDistillModel, readDistillEnabled, writeDistillEnabled } from '../lib/persist.js'
import { describeRoot, detectChanges, scanMarkdown, gitHealthy } from '../lib/changes.js'
import { clampBytes, contentKey, cleanBody, distillWithModel, DistillState } from '../lib/distill.js'

/** Create a patch file with the plugin row and a distill block. */
function patchWith(content) {
  const base = mkdtempSync(join(tmpdir(), 'distill-'))
  const path = join(base, 'cordis.patch.yml')
  writeFileSync(path, content, 'utf8')
  return path
}

const BASE = [
  '# profile patch',
  '- id: mnemon-sync-monitor',
  '  name: dsh-mnemon-sync-monitor',
  '  config:',
  '    enabled: true',
  '    roots:',
  '      - C:\\old\\one',
  '    debounceMs: 1200',
  '    distill:',
  '      enabled: false',
  '      automatic: true',
  '      debounceMs: 30000',
  '      command: ""',
  '',
].join('\n')

// ---------------------------------------------------------------- persist

test('readDistillModel returns undefined when the key is absent', () => {
  const path = patchWith(BASE)
  assert.equal(readDistillModel(path), undefined)
})

test('writeDistillModel round-trips a [provider, model] pair', () => {
  const path = patchWith(BASE)
  const result = writeDistillModel(path, { provider: 'workbuddy', model: 'hy4free' })
  assert.equal(result.changed, true)
  assert.deepEqual(readDistillModel(path), { provider: 'workbuddy', model: 'hy4free' })
})

test('writeDistillModel stores the composer identity encoding', () => {
  const path = patchWith(BASE)
  writeDistillModel(path, { provider: 'workbuddy', model: 'hy4free' })
  const text = readFileSync(path, 'utf8')
  assert.ok(text.includes('distillModel:'))
  // The value must be the JSON pair, quoted so YAML keeps it literal.
  assert.ok(text.includes('distillModel: "[\\"workbuddy\\",\\"hy4free\\"]"'))
  // And it must decode back to the same pair.
  assert.deepEqual(readDistillModel(path), { provider: 'workbuddy', model: 'hy4free' })
})

test('writeDistillModel is a no-op when the selection is unchanged', () => {
  const path = patchWith(BASE)
  writeDistillModel(path, { provider: 'workbuddy', model: 'hy4free' })
  const again = writeDistillModel(path, { provider: 'workbuddy', model: 'hy4free' })
  assert.equal(again.changed, false)
})

test('writeDistillModel clears the selection', () => {
  const path = patchWith(BASE)
  writeDistillModel(path, { provider: 'workbuddy', model: 'hy4free' })
  writeDistillModel(path, null)
  assert.equal(readDistillModel(path), undefined)
})

test('writeDistillModel leaves the roots block untouched', () => {
  const path = patchWith(BASE)
  writeDistillModel(path, { provider: 'workbuddy', model: 'hy4free' })
  assert.deepEqual(readRoots(path), ['C:\\old\\one'])
})

test('readDistillEnabled reads the distill block, not the row-level switch', () => {
  const path = patchWith(BASE)
  assert.equal(readDistillEnabled(path), false)
})

test('writeDistillEnabled flips only distill.enabled', () => {
  const path = patchWith(BASE)
  writeDistillEnabled(path, true)
  assert.equal(readDistillEnabled(path), true)
  const text = readFileSync(path, 'utf8')
  // The row-level enabled: true (the watcher master switch) must survive.
  assert.ok(text.includes('    enabled: true'))
  // And the distill one must have become true.
  assert.ok(text.includes('      enabled: true'))
})

test('writeDistillEnabled is idempotent', () => {
  const path = patchWith(BASE)
  writeDistillEnabled(path, true)
  const again = writeDistillEnabled(path, true)
  assert.equal(again.changed, false)
})

// ---------------------------------------------------------------- changes

test('describeRoot falls back to mtime for a non-git directory', () => {
  const base = mkdtempSync(join(tmpdir(), 'plain-'))
  const profile = describeRoot(base)
  assert.equal(profile.strategy, 'mtime')
  assert.match(profile.reason, /not a git work tree/)
})

test('scanMarkdown skips tooling sidecar directories', () => {
  const base = mkdtempSync(join(tmpdir(), 'scan-'))
  mkdirSync(join(base, 'notes'), { recursive: true })
  mkdirSync(join(base, '.agents', 'skills'), { recursive: true })
  mkdirSync(join(base, 'logseq'), { recursive: true })
  writeFileSync(join(base, 'notes', 'a.md'), '# a\n\n' + 'x'.repeat(300), 'utf8')
  writeFileSync(join(base, '.agents', 'skills', 'b.md'), '# b\n\n' + 'x'.repeat(300), 'utf8')
  writeFileSync(join(base, 'logseq', 'c.md'), '# c\n\n' + 'x'.repeat(300), 'utf8')
  const rels = scanMarkdown(base).map((f) => f.rel)
  assert.ok(rels.includes('notes/a.md'))
  assert.ok(!rels.some((r) => r.includes('.agents')))
  assert.ok(!rels.some((r) => r.includes('logseq')))
})

test('detectChanges records a baseline on the first run', () => {
  const base = mkdtempSync(join(tmpdir(), 'first-'))
  writeFileSync(join(base, 'a.md'), '# a\n\n' + 'x'.repeat(300), 'utf8')
  const result = detectChanges(base, undefined)
  assert.equal(result.mode, 'mtime')
  assert.match(result.note, /mtime strategy/)
  // The first run has no baseline, so everything is reported as changed.
  assert.equal(result.changed.length, 1)
})

test('detectChanges reports nothing when nothing changed', () => {
  const base = mkdtempSync(join(tmpdir(), 'same-'))
  writeFileSync(join(base, 'a.md'), '# a\n\n' + 'x'.repeat(300), 'utf8')
  detectChanges(base, undefined)
  const high = scanMarkdown(base).reduce((max, f) => (f.mtimeMs > max ? f.mtimeMs : max), 0) + 1
  const result = detectChanges(base, { highWaterMs: high })
  assert.equal(result.changed.length, 0)
})

// ---------------------------------------------------------------- distill

test('clampBytes cuts on a byte budget without splitting a character', () => {
  const text = '中'.repeat(5000)
  const out = clampBytes(text)
  assert.ok(Buffer.byteLength(out, 'utf8') <= 7800)
  assert.equal(out.length, [...out].length)
})

test('clampBytes leaves short text untouched', () => {
  assert.equal(clampBytes('short'), 'short')
})

test('contentKey ignores punctuation and whitespace', () => {
  assert.equal(contentKey('同样的 内容！'), contentKey('同样的内容'))
})

test('cleanBody strips frontmatter and Logseq bullets', () => {
  const out = cleanBody('---\ntitle: x\n---\n\n- # Heading\n\t- bullet')
  assert.ok(!out.includes('title: x'))
  assert.ok(out.includes('# Heading'))
  assert.ok(out.includes('bullet'))
})

test('distillWithModel returns the model insights', async () => {
  const reply = JSON.stringify({
    insights: [
      { content: '记忆空间单条上限 8000 字节，超出静默截断。', category: 'fact', importance: 5, tags: ['a'], entities: ['b'] },
      { content: '蒸馏结论二，包含具体约束与测量数据说明。', category: 'insight', importance: 3, tags: [], entities: [] },
    ],
  })
  const out = await distillWithModel(async () => reply, 'notes.md', 'body text', { maxInsights: 4 })
  assert.equal(out.length, 2)
  assert.equal(out[0].category, 'fact')
  assert.equal(out[0].importance, 5)
})

test('distillWithModel keeps short but meaningful insights', async () => {
  // A 33-character conclusion is still a conclusion: length is not density.
  const reply = JSON.stringify({
    insights: [{ content: '实测最长三条恰好 7800 字节且结尾断在半句。', category: 'fact', importance: 4 }],
  })
  const out = await distillWithModel(async () => reply, 'notes.md', 'body', { maxInsights: 4 })
  assert.equal(out.length, 1)
})

test('distillWithModel returns nothing when the reply is not JSON', async () => {
  const out = await distillWithModel(async () => 'not json at all', 'notes.md', 'body', { maxInsights: 4 })
  assert.equal(out.length, 0)
})

test('DistillState round-trips a root state', () => {
  const base = mkdtempSync(join(tmpdir(), 'state-'))
  const state = new DistillState(base)
  assert.equal(state.load(base), undefined)
  state.save(base, { commit: 'abc123', highWaterMs: 42, updatedAt: 'now' })
  const loaded = state.load(base)
  assert.equal(loaded.commit, 'abc123')
  assert.equal(loaded.highWaterMs, 42)
})
