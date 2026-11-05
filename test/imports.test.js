import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const LIB = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib')

/**
 * Every relative import must resolve to a real export.
 *
 * WHY THIS TEST EXISTS
 * The plugin disappeared after a restart because lib/index.js imported four
 * names that lib/persist.js did not export. ESM resolves named imports at
 * INSTANTIATION, before any code runs, so apply() never executed: no log line,
 * no error the host could attribute, just a missing settings page. A partial
 * copy (one file updated, its dependency not) produces exactly this, and neither
 * `node --check` nor "it ran before" catches it - only loading does.
 *
 * This test is a static approximation that does not need to import the modules,
 * so it still works when a module is unloadable for other reasons.
 */
function exportsOf(source) {
  const names = new Set()
  const patterns = [
    /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    /export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
    /export\s+class\s+([A-Za-z_$][\w$]*)/g,
  ]
  for (const re of patterns) {
    let m
    while ((m = re.exec(source)) !== null) names.add(m[1])
  }
  // export { a, b as c } / export { a } from './x.js'
  const list = /export\s*\{([^}]*)\}/g
  let block
  while ((block = list.exec(source)) !== null) {
    for (const part of block[1].split(',')) {
      const trimmed = part.trim()
      if (trimmed === '') continue
      const alias = /\bas\s+([A-Za-z_$][\w$]*)$/.exec(trimmed)
      names.add(alias !== null ? alias[1] : trimmed.replace(/^type\s+/, ''))
    }
  }
  return names
}

/** Every `import { ... } from './local.js'` in a source file. */
function localImports(source) {
  const out = []
  const re = /import\s*\{([^}]*)\}\s*from\s*['"]\.\/([^'"]+)['"]/g
  let m
  while ((m = re.exec(source)) !== null) {
    const file = m[2]
    for (const part of m[1].split(',')) {
      const trimmed = part.trim().replace(/^type\s+/, '')
      if (trimmed === '') continue
      out.push({ name: trimmed.split(/\s+as\s+/)[0], file })
    }
  }
  return out
}

test('every named import from a sibling module is actually exported', () => {
  const problems = []
  for (const entry of readdirSync(LIB)) {
    if (!entry.endsWith('.js')) continue
    const source = readFileSync(join(LIB, entry), 'utf8')
    for (const spec of localImports(source)) {
      const target = join(LIB, spec.file)
      let targetSource
      try {
        targetSource = readFileSync(target, 'utf8')
      } catch {
        problems.push(`${entry} imports from missing file ./${spec.file}`)
        continue
      }
      const available = exportsOf(targetSource)
      if (!available.has(spec.name)) {
        problems.push(`${entry}: '${spec.name}' is not exported by ${spec.file} (has: ${[...available].sort().join(', ')})`)
      }
    }
  }
  assert.deepEqual(problems, [], 'unresolved imports:\n' + problems.join('\n'))
})

test('the plugin and each of its siblings load together', async () => {
  // Static analysis cannot see re-exports through a proxy; loading is the truth.
  const { pathToFileURL } = await import('node:url')
  for (const entry of readdirSync(LIB)) {
    if (!entry.endsWith('.js')) continue
    await import(pathToFileURL(join(LIB, entry)).href)
  }
  const plugin = await import(pathToFileURL(join(LIB, 'index.js')).href)
  assert.equal(plugin.name, 'dsh-mnemon-sync-monitor')
  assert.equal(typeof plugin.apply, 'function')
})

test('the plugin declares services it actually reads', async () => {
  const source = readFileSync(join(LIB, 'index.js'), 'utf8')
  assert.match(source, /export const inject = \['webServer'(, 'connection')?\]/)
})
