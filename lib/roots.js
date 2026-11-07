/**
 * Root canonicalisation: one physical file belongs to exactly one pipeline.
 *
 * WHY THIS EXISTS
 * A root is not just a display string: it is the key of a distillation ledger
 * (`<store>/.distill/<sha256(resolve(root))>.json`). Two configured roots that
 * point at overlapping directories therefore get two INDEPENDENT ledgers, and a
 * note reachable through both is enumerated twice — once as `inner/shared.md`
 * under the child root, once as `shared.md` under the parent. Both copies are
 * pending in their own ledger, so both are dispatched, and the model is paid
 * twice for the same bytes.
 *
 * The content-key dedupe cannot be relied on to hide that: it only suppresses a
 * duplicate when the model happens to return byte-identical wording, and at
 * temperature 0.2 it usually does not. So the fix has to happen earlier, before
 * anything is scanned: collapse the configured list to a set of roots where no
 * root is reachable from another.
 *
 * THE RULE: the outermost root owns the file.
 *
 * This is what a user means when they watch a vault and then also watch one
 * folder inside it — they expect the folder to be *covered*, not *double
 * counted*. It is also the only rule that is stable under reordering: the
 * ancestor always wins, so `[a, a/b]` and `[a/b, a]` canonicalise identically.
 * The alternative ("first one listed wins") would make the pass depend on list
 * order, and the user cannot see the list order's consequences.
 *
 * @module dsh-mnemon-sync-monitor/roots
 */
import { resolve, sep } from 'node:path'

/**
 * Whether path comparisons should ignore case.
 *
 * Windows and macOS ship case-insensitive file systems by default, so
 * `C:\Vault` and `c:\vault` are one directory and must not become two roots.
 * Linux is left case-sensitive so two genuinely distinct directories are not
 * merged.
 */
const FOLD_CASE = process.platform === 'win32' || process.platform === 'darwin'

/**
 * Normalise a path for COMPARISON only — never for display or for I/O.
 *
 * Absolute, case-folded where the platform folds, with trailing separators
 * removed (except a bare drive/root, which would otherwise become empty).
 *
 * @param {string} path Any path.
 * @returns {string} Comparison key.
 */
export function rootKey(path) {
  const absolute = resolve(path)
  const folded = FOLD_CASE ? absolute.toLowerCase() : absolute
  const trimmed = folded.replace(/[\\/]+$/u, '')
  return trimmed === '' ? folded : trimmed
}

/**
 * Whether one root lies strictly inside another.
 *
 * Compares whole path segments, so `/vault` does not "contain" `/vault2`: a
 * naive `startsWith` would say it does, and would silently drop a legitimate
 * second vault.
 *
 * @param {string} candidate Possible descendant.
 * @param {string} owner Possible ancestor.
 * @returns {boolean} True when candidate is a strict descendant of owner.
 */
export function isInsideRoot(candidate, owner) {
  const a = rootKey(candidate)
  const b = rootKey(owner)
  if (a === b) return false
  return a.startsWith(b + sep) || a.startsWith(b + '/')
}

/**
 * Describe how a candidate root conflicts with an existing one, if it does.
 *
 * Used by `POST /roots` to refuse to CREATE an overlap in the first place, so
 * the user is told at the moment they add the second path rather than silently
 * losing the notes it would have covered.
 *
 * @param {string} candidate Root the caller wants to add.
 * @param {string[]} roots Roots already configured.
 * @returns {{root: string, relation: 'same'|'inside'|'contains'}|undefined} Conflict.
 */
export function findRootConflict(candidate, roots) {
  const key = rootKey(candidate)
  for (const root of roots) {
    if (typeof root !== 'string' || root.trim() === '') continue
    if (rootKey(root) === key) return { root, relation: 'same' }
    if (isInsideRoot(candidate, root)) return { root, relation: 'inside' }
    if (isInsideRoot(root, candidate)) return { root, relation: 'contains' }
  }
  return undefined
}

/**
 * Collapse a configured root list to one root per physical directory.
 *
 * Two things are removed, and both are reported so the caller can say what
 * happened instead of quietly watching less than the user asked for:
 *
 *   - exact duplicates (same directory written twice, or written with and
 *     without a trailing separator);
 *   - descendants of another root in the same list (the ancestor owns them).
 *
 * The survivors keep their configured order — that order is user-visible in the
 * settings page and is the order the round-robin budget cycles through, so it
 * must not be reshuffled by this function.
 *
 * @param {string[]} roots Configured roots, in configured order.
 * @returns {{roots: string[], dropped: Array<{root: string, owner: string, relation: 'duplicate'|'inside'}>}} Canonical set and what was folded into it.
 */
export function canonicalRoots(roots) {
  const candidates = []
  const seen = new Set()
  const dropped = []

  for (const raw of roots ?? []) {
    if (typeof raw !== 'string' || raw.trim() === '') continue
    const absolute = resolve(raw)
    const key = rootKey(absolute)
    if (seen.has(key)) {
      // Report the first spelling as the owner: that is the one being kept.
      const owner = candidates.find((candidate) => candidate.key === key)
      dropped.push({ root: absolute, owner: owner === undefined ? absolute : owner.root, relation: 'duplicate' })
      continue
    }
    seen.add(key)
    candidates.push({ root: absolute, key })
  }

  // Shortest key first, so an ancestor is always considered before any of its
  // descendants no matter what order the user listed them in. The locale
  // tie-break only keeps equal-length siblings deterministic.
  const byAncestry = candidates.slice().sort((a, b) => (a.key.length - b.key.length) || a.key.localeCompare(b.key))

  /** @type {string[]} */
  const accepted = []
  for (const candidate of byAncestry) {
    const owner = accepted.find((root) => isInsideRoot(candidate.root, root))
    if (owner !== undefined) {
      dropped.push({ root: candidate.root, owner, relation: 'inside' })
      continue
    }
    accepted.push(candidate.root)
  }

  // Back to configured order for the survivors.
  const acceptedKeys = new Set(accepted.map((root) => rootKey(root)))
  const survivors = candidates
    .filter((candidate) => acceptedKeys.has(candidate.key))
    .map((candidate) => candidate.root)

  return { roots: survivors, dropped }
}
