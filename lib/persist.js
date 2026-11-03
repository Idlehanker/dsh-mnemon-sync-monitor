/**
 * Persistence for the watched-root list.
 *
 * The page must survive a restart, and the running Host reads its configuration
 * from the profile patch layer, so a UI edit is only real once it is written
 * where the launcher reads it. This module owns that one write: it replaces the
 * plugin's own config block in \`cordis.patch.yml\` and leaves every other row
 * byte-identical.
 *
 * It deliberately does not parse the whole file into a model and re-serialize:
 * the patch layer is a hand-edited document with comments, and a round trip
 * through YAML would delete them. Instead it replaces the \`roots:\` sequence
 * inside this plugin's block, or appends the block when absent.
 *
 * @module dsh-mnemon-sync-monitor/persist
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'

/** Plugin row id inside the patch layer. */
export const ROW_ID = 'mnemon-sync-monitor'

/**
 * Quote a value for YAML when it needs quoting.
 * @param {string} value Raw scalar.
 * @returns {string} YAML scalar.
 */
function yamlScalar(value) {
  // A plain Windows path is valid YAML only when it starts with a letter or a
  // quote; backslashes and colons would otherwise change the meaning.
  return /^[A-Za-z0-9_./\\-]+$/u.test(value) ? value : JSON.stringify(value)
}

/**
 * Render the roots block for one indentation level.
 * @param {string[]} roots Absolute roots.
 * @param {string} indent Indentation to apply.
 * @returns {string} YAML lines, newline-terminated.
 */
function renderRoots(roots, indent) {
  if (roots.length === 0) return indent + 'roots: []\n'
  return indent + 'roots:\n' + roots.map((root) => indent + '  - ' + yamlScalar(root) + '\n').join('')
}

/**
 * Locate this plugin's row and the line range of its \`roots\` entry.
 * @param {string[]} lines Patch file lines.
 * @returns {{rowStart: number, blockEnd: number, rootsStart: number, rootsEnd: number} | undefined} Bounds.
 */
function locate(lines) {
  let rowStart = -1
  for (let index = 0; index < lines.length; index += 1) {
    if (/^-\s+id:\s*mnemon-sync-monitor\s*$/u.test(lines[index])) { rowStart = index; break }
  }
  if (rowStart < 0) return undefined

  // The row's block runs until the next top-level "- " entry.
  let blockEnd = lines.length
  for (let index = rowStart + 1; index < lines.length; index += 1) {
    if (/^-\s/u.test(lines[index])) { blockEnd = index; break }
  }

  let rootsStart = -1
  let rootsEnd = -1
  for (let index = rowStart; index < blockEnd; index += 1) {
    if (/^\s+roots:\s*(\[\s*\])?\s*$/u.test(lines[index])) {
      rootsStart = index
      rootsEnd = index + 1
      // A block sequence continues while lines are more indented than 'roots:'.
      const baseIndent = lines[index].match(/^(\s*)/u)[1].length
      while (rootsEnd < blockEnd) {
        const line = lines[rootsEnd]
        if (line.trim() === '') { rootsEnd += 1; continue }
        const indent = line.match(/^(\s*)/u)[1].length
        if (indent <= baseIndent || !/^\s*-/u.test(line)) break
        rootsEnd += 1
      }
      break
    }
  }
  return { rowStart, blockEnd, rootsStart, rootsEnd }
}

/**
 * Rewrite the plugin's roots inside a patch file, preserving every other line.
 *
 * @param {string} patchPath Absolute \`cordis.patch.yml\` path.
 * @param {string[]} roots New roots.
 * @returns {{changed: boolean, backup?: string}} Outcome; \`changed\` is false when already equal.
 */
export function writeRoots(patchPath, roots) {
  if (!existsSync(patchPath)) throw new Error('profile patch not found: ' + patchPath)
  const text = readFileSync(patchPath, 'utf8')
  const lines = text.split('\n')

  const found = locate(lines)
  if (found === undefined) {
    // No row yet: append a complete block.
    const block = [
      '',
      '# 实时同步监听：知识库变更自动写入 Documents（插件 dsh-mnemon-sync-monitor）',
      '- id: ' + ROW_ID,
      '  name: dsh-mnemon-sync-monitor',
      '  config:',
      '    enabled: true',
      renderRoots(roots, '    ').trimEnd(),
      '    debounceMs: 1200',
      '    minBytes: 200',
      '    prune: false',
      '    dryRun: false',
      '',
    ].join('\n')
    writeFileSync(patchPath, text.replace(/\n*$/u, '\n') + block, 'utf8')
    return { changed: true }
  }

  if (found.rootsStart < 0) {
    // Row exists but has no roots key: insert one after the row's config line.
    const indent = '    '
    lines.splice(found.rowStart + 1, 0, renderRoots(roots, indent).trimEnd())
    writeFileSync(patchPath, lines.join('\n'), 'utf8')
    return { changed: true }
  }

  const indent = '    '
  const replacement = renderRoots(roots, indent).trimEnd().split('\n')
  const before = lines.slice(found.rootsStart, found.rootsEnd).join('\n')
  const after = replacement.join('\n')
  if (before === after) return { changed: false }

  lines.splice(found.rootsStart, found.rootsEnd - found.rootsStart, ...replacement)
  const backup = patchPath + '.bak'
  copyFileSync(patchPath, backup)
  writeFileSync(patchPath, lines.join('\n'), 'utf8')
  return { changed: true, backup }
}
