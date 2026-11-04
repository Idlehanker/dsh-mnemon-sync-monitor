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
 * Read the plugin's roots back out of a patch file.
 *
 * The page must show what is on disk, which can differ from the live watcher
 * list after a manual edit. Parsing only this plugin's own `roots:` sequence
 * keeps the answer independent of the rest of the file.
 *
 * @param {string} patchPath Absolute `cordis.patch.yml` path.
 * @returns {string[]} Configured roots, in order; empty when absent.
 */
export function readRoots(patchPath) {
  if (!existsSync(patchPath)) return []
  const lines = readFileSync(patchPath, 'utf8').split('\n')
  const found = locate(lines)
  if (found === undefined || found.rootsStart < 0) return []
  const roots = []
  for (let index = found.rootsStart + 1; index < found.rootsEnd; index += 1) {
    const match = /^\s+-\s+(.+?)\s*$/u.exec(lines[index])
    if (match === null) continue
    let value = match[1]
    if (value.startsWith('"') && value.endsWith('"')) {
      try { value = JSON.parse(value) } catch { /* keep the quoted text */ }
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1).replace(/''/gu, "'")
    }
    if (value !== '') roots.push(value)
  }
  return roots
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

  // Preserve the file's own indentation so a hand-formatted patch keeps its shape.
  // Compare decoded values, not text: an unquoted path and its quoted form are
  // the same configuration, and rewriting for that alone would churn the file.
  const current = readRoots(patchPath)
  if (current.length === roots.length && current.every((value, position) => value === roots[position])) {
    return { changed: false }
  }

  const existingIndent = lines[found.rootsStart].match(/^(\s*)/u)[1]
  const replacement = renderRoots(roots, existingIndent).trimEnd().split('\n')

  lines.splice(found.rootsStart, found.rootsEnd - found.rootsStart, ...replacement)
  const backup = patchPath + '.bak'
  copyFileSync(patchPath, backup)
  writeFileSync(patchPath, lines.join('\n'), 'utf8')
  return { changed: true, backup }
}

/**
 * Read the distillation model selection from the plugin's config block.
 *
 * The value is the SAME identity the main composer uses: a `[provider, model]`
 * pair, JSON-encoded by the composer's `modelValue()`. Keeping this single
 * identity is what stops the settings page and the composer from disagreeing
 * after a provider changes.
 *
 * @param {string} patchPath Absolute path to cordis.patch.yml.
 * @returns {{provider: string, model: string}|undefined}
 */
export function readDistillModel(patchPath) {
  if (!existsSync(patchPath)) return undefined
  const lines = readFileSync(patchPath, 'utf8').split('\n')
  const found = locate(lines)
  if (found === undefined) return undefined
  for (let index = found.rowStart + 1; index < found.blockEnd; index += 1) {
    const match = /^(\s*)distillModel:\s*(.+?)\s*$/u.exec(lines[index])
    if (match === null) continue
    let value = match[2]
    if (value.startsWith('"') && value.endsWith('"')) {
      try { value = JSON.parse(value) } catch { /* keep quoted form */ }
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1).replace(/''/gu, "'")
    }
    try {
      const pair = JSON.parse(value)
      if (Array.isArray(pair) && pair.length === 2
        && typeof pair[0] === 'string' && typeof pair[1] === 'string') {
        return { provider: pair[0], model: pair[1] }
      }
    } catch { /* not a pair, ignore */ }
    return undefined
  }
  return undefined
}

/**
 * Persist a distillation model selection, preserving every other line.
 *
 * @param {string} patchPath Absolute path to cordis.patch.yml.
 * @param {{provider: string, model: string}|null} selection null clears it.
 * @returns {{changed: boolean, backup?: string}}
 */
export function writeDistillModel(patchPath, selection) {
  if (!existsSync(patchPath)) throw new Error('profile patch not found: ' + patchPath)
  const text = readFileSync(patchPath, 'utf8')
  const lines = text.split('\n')
  const found = locate(lines)
  if (found === undefined) throw new Error('plugin row missing from profile patch')

  const current = readDistillModel(patchPath)
  const same = selection === null
    ? current === undefined
    : current !== undefined && current.provider === selection.provider && current.model === selection.model
  if (same) return { changed: false }

  // Locate an existing distillModel key inside this row.
  let at = -1
  for (let index = found.rowStart + 1; index < found.blockEnd; index += 1) {
    if (/^\s*distillModel:/u.test(lines[index])) { at = index; break }
  }

  if (selection === null) {
    if (at < 0) return { changed: false }
    lines.splice(at, 1)
  } else {
    const indent = at >= 0
      ? lines[at].match(/^(\s*)/u)[1]
      : '    '
    // JSON.stringify gives the exact [provider, model] identity used by the
    // composer; quote it so YAML treats the brackets and comma literally.
    const line = indent + 'distillModel: ' + JSON.stringify(JSON.stringify([selection.provider, selection.model]))
    if (at >= 0) lines[at] = line
    else {
      // Insert just before the end of this row's config block.
      lines.splice(found.blockEnd, 0, line)
    }
  }

  const backup = patchPath + '.bak'
  copyFileSync(patchPath, backup)
  writeFileSync(patchPath, lines.join('\n'), 'utf8')
  return { changed: true, backup }
}


/**
 * Locate the `distill:` sub-block inside the plugin's config row.
 * The row also has a top-level `enabled:` (the watcher master switch), so the
 * search must be scoped to the distill block rather than matching the first
 * `enabled:` in the row.
 *
 * @param {string[]} lines Patch lines.
 * @returns {{start: number, end: number, enabledAt: number}|undefined}
 */
function locateDistill(lines) {
  const found = locate(lines)
  if (found === undefined) return undefined
  let start = -1
  for (let index = found.rowStart + 1; index < found.blockEnd; index += 1) {
    if (/^\s*distill:\s*$/u.test(lines[index])) { start = index; break }
  }
  if (start < 0) return undefined
  const baseIndent = lines[start].match(/^(\s*)/u)[1].length
  let end = found.blockEnd
  for (let index = start + 1; index < found.blockEnd; index += 1) {
    const line = lines[index]
    if (line.trim() === '') continue
    const indent = line.match(/^(\s*)/u)[1].length
    if (indent <= baseIndent) { end = index; break }
  }
  let enabledAt = -1
  for (let index = start + 1; index < end; index += 1) {
    if (/^\s*enabled:/u.test(lines[index])) { enabledAt = index; break }
  }
  return { start, end, enabledAt }
}

/**
 * Read the distillation on/off switch from the profile patch.
 * @param {string} patchPath Absolute path to cordis.patch.yml.
 * @returns {boolean|undefined} undefined when the block or key is absent.
 */
export function readDistillEnabled(patchPath) {
  if (!existsSync(patchPath)) return undefined
  const lines = readFileSync(patchPath, 'utf8').split('\n')
  const block = locateDistill(lines)
  if (block === undefined || block.enabledAt < 0) return undefined
  const value = lines[block.enabledAt].replace(/^\s*enabled:\s*/u, '').trim()
  return value === 'true' ? true : value === 'false' ? false : undefined
}

/**
 * Persist the distillation on/off switch, preserving every other line.
 *
 * @param {string} patchPath Absolute path to cordis.patch.yml.
 * @param {boolean} enabled
 * @returns {{changed: boolean, backup?: string}}
 */
export function writeDistillEnabled(patchPath, enabled) {
  if (!existsSync(patchPath)) throw new Error('profile patch not found: ' + patchPath)
  const text = readFileSync(patchPath, 'utf8')
  const lines = text.split('\n')
  const block = locateDistill(lines)
  if (block === undefined) throw new Error('distill block missing from profile patch')

  const current = readDistillEnabled(patchPath)
  if (current === enabled) return { changed: false }
  if (block.enabledAt >= 0) {
    const indent = lines[block.enabledAt].match(/^(\s*)/u)[1]
    lines[block.enabledAt] = indent + 'enabled: ' + (enabled ? 'true' : 'false')
  } else {
    const indent = lines[block.start].match(/^(\s*)/u)[1] + '  '
    lines.splice(block.start + 1, 0, indent + 'enabled: ' + (enabled ? 'true' : 'false'))
  }
  const backup = patchPath + '.bak'
  copyFileSync(patchPath, backup)
  writeFileSync(patchPath, lines.join('\n'), 'utf8')
  return { changed: true, backup }
}
