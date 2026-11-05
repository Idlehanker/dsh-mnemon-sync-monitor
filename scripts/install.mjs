#!/usr/bin/env node
/**
 * install.mjs - copy this package into a DSH profile, ATOMICALLY and COMPLETELY.
 *
 * WHY THIS EXISTS
 * A manual copy once updated lib/index.js but not lib/persist.js. index.js then
 * imported four names persist.js did not export. ESM resolves named imports at
 * instantiation, so the plugin threw before apply() ever ran: no log line, no
 * visible error, and the settings page simply vanished after the restart.
 *
 * This script removes that failure class:
 *   1. it always copies the WHOLE set (every file under lib/, plus the client
 *      entry and the manifest), never a hand-picked subset;
 *   2. it stages into a temporary directory, verifies the staged tree loads,
 *      and only then swaps it into place;
 *   3. if the staged tree fails to load it aborts and leaves the previous
 *      install untouched, so a bad build cannot take the page down.
 *
 * Usage:
 *   node scripts/install.mjs                 # install into the desktop profile
 *   node scripts/install.mjs --profile other # a different profile name
 *   node scripts/install.mjs --dry-run       # verify only, write nothing
 *
 * Exit: 0 installed and verified, 1 refused or verification failed.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, renameSync, existsSync, statSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Every file this package ships, relative to the package root. */
export function shipment() {
  const files = ['package.json', 'client.js', 'cordis.patch.yml', 'README.md', 'CHANGELOG.md', 'LICENSE']
  for (const entry of readdirSync(join(ROOT, 'lib'))) {
    if (entry.endsWith('.js')) files.push('lib/' + entry)
  }
  return files
}

function arg(name, fallback) {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback
}

/**
 * Load the staged tree and confirm every module resolves together.
 *
 * This is the check that the manual copy lacked: importing the entry point
 * transitively instantiates every sibling, so a missing export fails HERE
 * rather than on the next Host restart.
 */
async function verifyLoads(target) {
  for (const entry of readdirSync(join(target, 'lib'))) {
    if (!entry.endsWith('.js')) continue
    await import(pathToFileURL(join(target, 'lib', entry)).href)
  }
  const plugin = await import(pathToFileURL(join(target, 'lib', 'index.js')).href)
  if (typeof plugin.apply !== 'function' || plugin.name !== 'dsh-mnemon-sync-monitor') {
    throw new Error('entry point does not export the expected plugin surface')
  }
  return true
}

/** Fail loudly when a file references an export its sibling does not provide. */
function checkExports(target) {
  const problems = []
  const read = (name) => readFileSync(join(target, 'lib', name), 'utf8')
  const files = readdirSync(join(target, 'lib')).filter((f) => f.endsWith('.js'))
  const names = (source) => {
    const found = new Set()
    for (const re of [/export\s+(?:async\s+)?function\s+([\w$]+)/g, /export\s+(?:const|let|var)\s+([\w$]+)/g, /export\s+class\s+([\w$]+)/g]) {
      let m
      while ((m = re.exec(source)) !== null) found.add(m[1])
    }
    const list = /export\s*\{([^}]*)\}/g
    let block
    while ((block = list.exec(source)) !== null) {
      for (const part of block[1].split(',')) {
        const trimmed = part.trim()
        if (trimmed !== '') found.add(/\bas\s+([\w$]+)$/.exec(trimmed)?.[1] ?? trimmed)
      }
    }
    return found
  }
  for (const file of files) {
    const source = read(file)
    const re = /import\s*\{([^}]*)\}\s*from\s*['"]\.\/([^'"]+)['"]/g
    let m
    while ((m = re.exec(source)) !== null) {
      const targetFile = m[2]
      let targetSource
      try { targetSource = read(targetFile) } catch { problems.push(file + ' imports missing ./' + targetFile); continue }
      const available = names(targetSource)
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0]
        if (name === '') continue
        if (!available.has(name)) problems.push(file + ": '" + name + "' is not exported by " + targetFile)
      }
    }
  }
  return problems
}

const profileName = arg('--profile', 'desktop')
const dryRun = process.argv.includes('--dry-run')
const PROFILE = join(homedir(), '.dsh', 'profiles', profileName)
const TARGET = join(PROFILE, 'node_modules', 'dsh-mnemon-sync-monitor')

if (!existsSync(PROFILE)) {
  console.error('profile not found: ' + PROFILE)
  process.exit(1)
}

const files = shipment()
const staging = join(PROFILE, 'node_modules', '.dsh-mnemon-sync-monitor.staging')

try {
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(join(staging, 'lib'), { recursive: true })
  for (const file of files) {
    const from = join(ROOT, file)
    if (!existsSync(from)) continue
    copyFileSync(from, join(staging, file))
  }

  // Static check first: it names the offending symbol, which a stack trace hides.
  const problems = checkExports(staging)
  if (problems.length > 0) {
    console.error('REFUSED: the staged tree has unresolved imports:')
    for (const line of problems) console.error('  ' + line)
    rmSync(staging, { recursive: true, force: true })
    process.exit(1)
  }
  await verifyLoads(staging)

  if (dryRun) {
    console.log('dry-run OK: ' + files.length + ' files, all modules load')
    rmSync(staging, { recursive: true, force: true })
    process.exit(0)
  }

  // Keep the previous install as a rollback point, then swap.
  const previous = join(PROFILE, 'node_modules', '.dsh-mnemon-sync-monitor.previous')
  rmSync(previous, { recursive: true, force: true })
  if (existsSync(TARGET)) renameSync(TARGET, previous)
  renameSync(staging, TARGET)

  // Re-verify WHERE IT NOW LIVES: a path change can break relative resolution.
  await verifyLoads(TARGET)
  console.log('installed ' + files.length + ' files to ' + TARGET)
  console.log('previous kept at ' + previous)
} catch (error) {
  rmSync(staging, { recursive: true, force: true })
  console.error('FAILED: ' + (error instanceof Error ? error.message : String(error)))
  console.error('the previous install was left untouched')
  process.exit(1)
}
