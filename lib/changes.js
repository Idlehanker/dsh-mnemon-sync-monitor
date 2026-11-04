/**
 * Change detection for the distill scheduler.
 *
 * The watcher only sees events while the Host is running. Anything edited with
 * DSH closed produces no event at all, so a distillation pass driven purely by
 * fs.watch would silently skip those edits forever.
 *
 * This module answers "what changed since last time" for the two kinds of root
 * this graph actually has, and it never trusts a single signal:
 *
 *   git roots   - compare a recorded commit against HEAD, then
 *                 git diff --name-status <old>..HEAD. Precise add/modify/delete.
 *   plain roots - record a high-water mtime; anything at or after it is changed.
 *                 Measured: 1,651 md files scan in 434 ms, so a full rescan per
 *                 pass is affordable and needs no index.
 *
 * The git path is an OPTIMISATION, never an assumption. A repo can be dirty (the
 * reference iNote checkout had 428 uncommitted paths, so HEAD did not describe the
 * working tree) or a probe can fail outright (OneDrive placeholders produced
 * "fatal: mmap failed" once). Either way the detector degrades to mtime and says
 * so, so the caller can log why instead of believing a stale diff.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';

/** Tooling/build/cache sidecars, not knowledge-base content.
 * Must match EXCLUDE_SEGMENTS in index.js exactly; the two sides drifted once
 * and logseq/ was indexed by one layer but skipped by the other. */
const EXCLUDE = new Set([
  '.git', '.agents', '.trash', '.obsidian', '.recycle', 'node_modules', '.venv',
  'dist', '.next', '.cache', 'logseq', 'assets', 'bak',
]);

const MIN_BYTES = 200;

/** Run git in a repo, returning stdout or undefined when it cannot answer. */
function git(root, args) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      timeout: 20000,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined;
  }
}

/** Is this directory the top of a git work tree? */
export function isGitRoot(root) {
  return git(root, ['rev-parse', '--is-inside-work-tree'])?.trim() === 'true';
}

/**
 * Describe a root once, so every pass decides the same way.
 *
 * git is preferred whenever the root IS a repository and git can actually answer:
 * a commit diff is exact (add/modify/delete, renamed detection, no false
 * positives) where mtime only says "touched at or after T". Two things demote a
 * root to mtime, and both were observed for real:
 *
 *   - the work tree is dirty, so HEAD does not describe it and a diff would miss
 *     every uncommitted edit (the old iNote checkout had 428 such paths)
 *   - git itself fails, e.g. "fatal: mmap failed" on OneDrive placeholders
 *
 * @param {string} root Absolute root.
 * @returns {{strategy: 'git'|'mtime', commit?: string, dirty?: number, reason?: string}}
 */
export function describeRoot(root) {
  const absolute = resolve(root);
  if (!isGitRoot(absolute)) return { strategy: 'mtime', reason: 'not a git work tree' };

  const commit = headCommit(absolute);
  if (commit === undefined) return { strategy: 'mtime', reason: 'git could not report HEAD' };

  const health = gitHealthy(absolute);
  if (!health.ok) {
    return { strategy: 'mtime', commit, dirty: health.dirty, reason: health.reason };
  }
  return { strategy: 'git', commit, dirty: 0 };
}

/** Current commit, or undefined when the repo cannot report one. */
export function headCommit(root) {
  const out = git(root, ['rev-parse', 'HEAD']);
  const sha = out?.trim();
  return sha !== undefined && /^[0-9a-f]{7,40}$/i.test(sha) ? sha : undefined;
}

/**
 * Is HEAD a trustworthy description of the working tree? A repo with staged or
 * unstaged changes answers no: diffing against HEAD would omit every edit that
 * was never committed.
 */
export function gitHealthy(root) {
  const out = git(root, ['status', '--porcelain']);
  if (out === undefined) return { ok: false, reason: 'git status failed' };
  const dirty = out.split('\n').filter((l) => l.trim() !== '').length;
  return dirty === 0 ? { ok: true, dirty: 0 } : { ok: false, dirty, reason: dirty + ' uncommitted paths' };
}

/** Walk a root for Markdown at or above the size floor. */
export function scanMarkdown(root) {
  const found = [];
  const base = resolve(root);
  const pending = [base];
  while (pending.length > 0) {
    const dir = pending.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (EXCLUDE.has(e.name)) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) { pending.push(abs); continue; }
      if (!e.isFile() || extname(e.name).toLowerCase() !== '.md') continue;
      let info;
      try { info = statSync(abs); } catch { continue; }
      if (info.size < MIN_BYTES) continue;
      found.push({ abs, rel: relative(base, abs).split(sep).join("/"), mtimeMs: info.mtimeMs, size: info.size });
    }
  }
  return found;
}

/**
 * Diff two commits, returning the touched Markdown paths. Undefined when git
 * cannot answer, so the caller can fall back instead of assuming no change.
 */
export function gitChanged(root, fromCommit, toCommit) {
  // core.quotepath=false keeps non-ASCII paths literal; without it git renders
  // every CJK filename as octal escapes (\344\270\211) and the path never
  // resolves back to a file on disk.
  const out = git(root, ['-c', 'core.quotepath=false', 'diff', '--name-status', fromCommit + '..' + toCommit, '--', '*.md']);
  if (out === undefined) return undefined;
  const rows = [];
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const m = /^([AMDRT])\d*\t(.+)$/.exec(trimmed);
    if (m === null) continue;
    const rel = m[2].replace(/^"|"$/g, "").replace(/\\/g, "/");
    if (extname(rel).toLowerCase() !== '.md') continue;
    rows.push({ rel, status: m[1] });
  }
  return rows;
}

/** Everything touched at or after the recorded high-water mark. */
function mtimeChanged(root, prev) {
  const files = scanMarkdown(root);
  const since = prev?.highWaterMs;
  if (since === undefined) {
    return files.map((f) => ({ rel: f.rel, status: 'U', mtimeMs: f.mtimeMs }));
  }
  return files
    .filter((f) => f.mtimeMs >= since)
    .map((f) => ({ rel: f.rel, status: 'M', mtimeMs: f.mtimeMs }));
}

/**
 * Decide what changed for one root.
 *
 * @param {string} root Absolute root path.
 * @param {object|undefined} prev Last recorded state for this root.
 * @returns {{mode: string, changed: object[], head?: string, note?: string}}
 */
export function detectChanges(root, prev) {
  const absolute = resolve(root);
  const profile = describeRoot(absolute);

  if (profile.strategy === 'git') {
    const head = profile.commit;
    if (prev?.commit !== undefined && prev.commit !== head) {
      const rows = gitChanged(absolute, prev.commit, head);
      if (rows !== undefined) {
        // git reports REPO-relative paths. When a root is a sub-directory of the
        // repo (LogseqGithub/pages and /journals share one HEAD), keep only paths
        // that actually resolve inside THIS root. Without this filter both roots
        // would distill every file the other one changed.
        const repoTop = git(absolute, ['rev-parse', '--show-toplevel'])?.trim();
        const rootRel = repoTop === undefined
          ? ''
          : relative(resolve(repoTop), absolute).split(sep).join('/');
        const prefix = rootRel === '' ? '' : rootRel + '/';
        const owned = rows.filter((row) => {
          if (prefix !== '' && !row.rel.startsWith(prefix)) return false;
          // Deleted files have no body to read; keep them so the caller can log.
          if (row.status === 'D') return true;
          const abs = join(absolute, ...row.rel.split('/'));
          return existsSync(abs);
        });
        return { mode: 'git', head, changed: owned, filtered: rows.length - owned.length };
      }
      return {
        mode: 'mtime',
        head,
        note: 'git fallback: diff failed',
        changed: mtimeChanged(absolute, prev),
      };
    }
    if (prev?.commit === head) return { mode: 'git', head, changed: [], note: 'HEAD unchanged' };
    return { mode: 'git', head, changed: [], note: 'first run: recording HEAD' };
  }

  return {
    mode: 'mtime',
    note: 'mtime strategy: ' + (profile.reason ?? 'unknown'),
    changed: mtimeChanged(absolute, prev),
  };
}

/** Highest mtime across a root, used as the next high-water mark. */
export function highWater(root) {
  return scanMarkdown(root).reduce((max, f) => (f.mtimeMs > max ? f.mtimeMs : max), 0);
}
