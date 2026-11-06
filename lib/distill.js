/**
 * The distill scheduler: turn changed vault files into Memory Space insights.
 *
 * WHY THIS LIVES IN THE WATCHER
 * The watcher already knows what changed and when. Re-deriving that in a second
 * component would duplicate the walk, the debounce, and the root bookkeeping.
 * It also already runs the Documents sync, so a file it just indexed is exactly
 * a file worth distilling.
 *
 * WHY IT NEEDS A MODEL
 * The heuristic distiller in kb-distill-sidecar.mjs keeps the original wording,
 * so it stores fragments rather than conclusions and its recall is barely better
 * than the lexical layer. Distillation only pays off when a model reduces a note
 * to self-contained claims. That is what `distillWithModel` does.
 *
 * WHAT IS PERSISTED
 * One small JSON state file per root under <store>/.distill/, holding the last
 * commit (git roots) and the mtime high-water mark (all roots). Without it every
 * pass would re-distil the whole vault.
 *
 * SAFETY
 * - Hard byte cap per insight, cut on character boundaries.
 * - Per-run and per-root caps so one burst cannot flood the 1,000-insight ceiling.
 * - Content-hash dedupe against what this run already produced.
 * - Every failure is logged and swallowed: distillation must never break the
 *   Documents sync that shares this process.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { scanMarkdown } from './changes.js';
import { readFileSync as readText } from 'node:fs';

/** Storage rejects content over 8,000 UTF-8 bytes; leave headroom. */
export const MAX_INSIGHT_BYTES = 7800;

/** Keep a string under a byte budget without splitting a UTF-8 sequence. */
export function clampBytes(text, limit = MAX_INSIGHT_BYTES) {
  if (Buffer.byteLength(text, 'utf8') <= limit) return text;
  let out = '';
  for (const ch of text) {
    if (Buffer.byteLength(out + ch, 'utf8') > limit) break;
    out += ch;
  }
  return out.trimEnd();
}

/** Strip frontmatter and Logseq bullets so the model sees prose. */
export function cleanBody(raw) {
  // Normalise first, then strip. The original order stripped frontmatter BEFORE
  // normalising and only matched LF fences, so a CRLF note kept its whole YAML
  // block and the model was asked to distil `tags:`/`aliases:` metadata.
  let t = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
  const fence = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/u.exec(t);
  if (fence !== null) t = t.slice(fence[0].length);
  const stripped = t.split('\n')
    .map((l) => l.replace(/^\s*-\s?/, ''))
    .join('\n')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return dropCodeBlocks(stripped);
}

/**
 * Remove fenced code blocks, then decide whether anything worth distilling is left.
 *
 * An Obsidian note can be almost entirely a ```dataview query — template scaffolding
 * with no knowledge in it. Measured: such a note distilled into "the file contains a
 * Dataview TABLE query WHERE contains(file.etags…)", which is a description of
 * syntax, not a fact about anything. Removing fenced blocks first means the model
 * only sees prose, and a note that is ALL code collapses to empty and is skipped.
 *
 * @param {string} text Normalised note text.
 * @returns {string} Text with fenced blocks removed.
 */
function dropCodeBlocks(text) {
  return text
    .replace(/^```[\s\S]*?^```[ \t]*$/gmu, '')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A stable key for dedupe across runs and versions. */
export function contentKey(text) {
  return createHash('sha256')
    .update(text.normalize('NFKC').replace(/[\s\p{P}\p{S}]+/gu, ''))
    .digest('hex');
}

/**
 * How many notes may be distilled at the same time.
 *
 * WHY A POOL AT ALL
 * The vault walk is cheap: 389 files scan in ~0.4 s. The entire wall clock of a
 * pass is the model call, one per note, 7-25 s each. Running them one after the
 * other makes a large backlog look like a hang, and the sync it shares a process
 * with gets no benefit from the idle time in between.
 *
 * WHY IT IS BOUNDED, AND WHY THE DEFAULT IS SMALL
 * - A provider that rate-limits answers 429s instead of getting faster, and every
 *   failed call leaves the note pending for the next pass.
 * - Each `mnemon import` child is its own process loading an embedding model, so
 *   unbounded fan-out trades model latency for CPU contention.
 * - 3 is enough to hide the per-call latency without turning a laptop fan on.
 * The cap is a hard ceiling: a hand-edited patch file cannot fan out past it.
 */
export const DISTILL_CONCURRENCY_DEFAULT = 3;
export const DISTILL_CONCURRENCY_MAX = 8;

/**
 * Clamp any authored or configured value to a usable worker count.
 *
 * Accepts the string a YAML patch file yields as readily as a number, because a
 * patch file is edited by hand and `concurrency: "4"` is a plausible typo that
 * should work rather than silently fall back to serial.
 *
 * @param {unknown} value Raw authored value.
 * @param {number} [fallback] Used when the value is not a number at all.
 * @returns {number} Integer in [1, DISTILL_CONCURRENCY_MAX].
 */
export function normalizeConcurrency(value, fallback = DISTILL_CONCURRENCY_DEFAULT) {
  const parsed = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback;
  const whole = Math.floor(parsed);
  if (whole < 1) return 1;
  if (whole > DISTILL_CONCURRENCY_MAX) return DISTILL_CONCURRENCY_MAX;
  return whole;
}

const DISTILL_SYSTEM = [
  'You distil a note into durable, self-contained insights for a semantic memory.',
  '',
  'Rules:',
  '- Each insight is one complete claim that stands alone without the note.',
  '- Preserve concrete names, numbers, paths and decisions; drop narrative filler.',
  '- Do not invent facts. If the note has no durable claim, return an empty list.',
  '- Prefer 1-4 insights. Each must be under 1,200 characters.',
  '- Write in the note language.',
  '',
  'Reply with JSON only: {"insights":[{"content":"...","category":"fact|decision|insight|context|preference","importance":1-5,"tags":["..."],"entities":["..."]}]}',
].join('\n');

function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return undefined; }
}

/**
 * Ask a model to distil one note body into insights.
 *
 * @param {(messages: object[]) => Promise<string>} complete Chat completion call.
 * @param {string} relPath Root-relative path, given to the model as context.
 * @param {string} body Cleaned note text.
 * @param {{maxInsights?: number}} [options] Per-note cap.
 * @returns {Promise<object[]>} Insights, each already byte-clamped.
 */
export async function distillWithModel(complete, relPath, body, options = {}) {
  const maxInsights = options.maxInsights ?? 4;
  // Measured on this gateway with workbuddy/hy4free: ~12-20 s for a short note but
  // **206 s** for a 12,000-character one. The plugin's own commandTimeoutMs was 180 s,
  // so every long note timed out, was recorded as an error, and never contributed an
  // insight — a silent cap on what could ever be distilled. 4,000 characters keeps a
  // call well inside the budget; a longer note is better served by its next section
  // than by an oversized single call.
  const MAX_SOURCE_CHARS = 4000;
  const source = body.length > MAX_SOURCE_CHARS ? body.slice(0, MAX_SOURCE_CHARS) : body;
  const reply = await complete([
    { role: 'system', content: DISTILL_SYSTEM },
    { role: 'user', content: 'File: ' + relPath + '\n\n' + source },
  ]);
  const parsed = extractJson(reply);
  const raw = Array.isArray(parsed?.insights) ? parsed.insights : [];
  const out = [];
  for (const item of raw.slice(0, maxInsights)) {
    const content = typeof item?.content === 'string' ? item.content.trim() : '';
    // Reject only empty/near-empty noise. A fixed character floor is the wrong
    // filter here: this project's own measured facts run 33-37 characters
    // ("记忆空间单条上限 8000 字节，超出静默截断。"), and a 40-character threshold
    // silently discarded every one of them. Density matters, length does not.
    if (content.length < 8) continue;
    const category = ['fact', 'decision', 'insight', 'context', 'preference'].includes(item?.category)
      ? item.category : 'insight';
    const importance = Number.isInteger(item?.importance)
      ? Math.min(5, Math.max(1, item.importance)) : 3;
    const tags = Array.isArray(item?.tags)
      ? item.tags.filter((t) => typeof t === 'string' && t.trim() !== '').slice(0, 8) : [];
    const entities = Array.isArray(item?.entities)
      ? item.entities.filter((t) => typeof t === 'string' && t.trim() !== '').slice(0, 12) : [];
    out.push({ content: clampBytes(content), category, importance, tags, entities });
  }
  return out;
}

/** Persistent per-root state: last commit and mtime high-water mark. */
export class DistillState {
  constructor(storeDirectory) {
    this.dir = join(resolve(storeDirectory), '.distill');
  }

  /** @param {string} root Absolute root path. */
  pathFor(root) {
    const key = createHash('sha256').update(resolve(root)).digest('hex').slice(0, 16);
    return join(this.dir, key + '.json');
  }

  load(root) {
    try {
      const p = this.pathFor(root);
      if (!existsSync(p)) return undefined;
      return JSON.parse(readFileSync(p, 'utf8'));
    } catch { return undefined; }
  }

  save(root, state) {
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.pathFor(root), JSON.stringify(state, null, 2), 'utf8');
      return true;
    } catch { return false; }
  }
}

//#region distillation ledger
/**
 * The distillation ledger: which note CONTENT has already produced insights.
 *
 * Why a hash ledger instead of the previous high-water mark.
 *
 * The old design asked "what changed since the last pass?" and advanced a
 * timestamp. That question has two failure modes that produced silently empty
 * Memory Spaces:
 *
 *   1. A first run has no previous mark, so the answer was "nothing changed" and
 *      a freshly configured vault distilled zero notes, forever.
 *   2. A budget-capped pass advanced the mark over files it never consumed, so the
 *      skipped notes were never revisited.
 *
 * Both disappear once the question becomes the user's actual question:
 *
 *   "which notes have no distilled content right now?"
 *
 * The answer is a set difference, not a timestamp comparison. It is idempotent
 * (running twice does nothing the second time), self-healing (a lost or reset
 * ledger simply causes re-distillation, and the CLI dedupes on content), and
 * correct across edits (a note whose bytes changed gets a new key).
 *
 * Shape on disk, per root:
 *
 *   { version: 2, root, entries: { <contentHash>: { rel, bytes, at, insights: [id] } } }
 *
 * The hash is of the CLEANED body (frontmatter stripped, code fences dropped) —
 * the exact text handed to the model — so a whitespace-only edit does not
 * invalidate the record but a real edit does.
 */
export class DistillLedger {
  /** @param {string} storeDirectory Documents store root. */
  constructor(storeDirectory) {
    this.dir = join(resolve(storeDirectory), '.distill')
    this.cache = new Map()
  }

  /** @param {string} root Absolute root path. */
  pathFor(root) {
    const key = createHash('sha256').update(resolve(root)).digest('hex').slice(0, 16)
    return join(this.dir, key + '.json')
  }

  /**
   * Load one root's ledger, migrating a v1 watermark file if that is all there is.
   * @param {string} root Absolute root path.
   * @returns {{version: number, root: string, entries: object}}
   */
  load(root) {
    const cached = this.cache.get(root)
    if (cached !== undefined) return cached
    let entries = {}
    try {
      const p = this.pathFor(root)
      if (existsSync(p)) {
        const parsed = JSON.parse(readFileSync(p, 'utf8'))
        // v1 files hold {commit, highWaterMs} and no entries. Treat them as empty:
        // the first pass after the upgrade re-checks every note, which is the
        // desired behaviour when we cannot prove what was distilled.
        if (parsed !== null && typeof parsed === 'object' && typeof parsed.entries === 'object' && parsed.entries !== null) {
          entries = parsed.entries
        }
      }
    } catch { entries = {} }
    const state = { version: 2, root: resolve(root), entries }
    this.cache.set(root, state)
    return state
  }

  /**
   * Record that one content hash produced the given insights.
   * @param {string} root Absolute root path.
   * @param {string} hash Cleaned-body hash.
   * @param {object} record Bookkeeping for this note.
   */
  mark(root, hash, record) {
    const state = this.load(root)
    state.entries[hash] = record
    this.cache.set(root, state)
  }

  /**
   * Forget a hash (used when its content vanished from the vault).
   * @param {string} root Absolute root path.
   * @param {string} hash Cleaned-body hash.
   */
  forget(root, hash) {
    const state = this.load(root)
    if (state.entries[hash] === undefined) return
    delete state.entries[hash]
    this.cache.set(root, state)
  }

  /**
   * Persist one root's ledger atomically.
   * @param {string} root Absolute root path.
   * @returns {boolean} Whether the write succeeded.
   */
  save(root) {
    const state = this.cache.get(root)
    if (state === undefined) return false
    try {
      mkdirSync(this.dir, { recursive: true })
      const target = this.pathFor(root)
      // Write-then-rename: a crash mid-write must not leave a truncated ledger.
      const temp = target + '.tmp'
      writeFileSync(temp, JSON.stringify(state, null, 2), 'utf8')
      renameSync(temp, target)
      return true
    } catch { return false }
  }

  /**
   * Drop entries whose content is no longer present in the vault.
   * @param {string} root Absolute root path.
   * @param {Set<string>} liveHashes Hashes seen in this scan.
   * @returns {number} How many entries were removed.
   */
  prune(root, liveHashes) {
    const state = this.load(root)
    let removed = 0
    for (const hash of Object.keys(state.entries)) {
      if (liveHashes.has(hash)) continue
      delete state.entries[hash]
      removed += 1
    }
    if (removed > 0) this.cache.set(root, state)
    return removed
  }
}

/**
 * Hash the exact text handed to the model.
 *
 * Whitespace is normalised so a trailing-newline edit does not trigger a costly
 * re-distillation, but every other byte counts: any real edit must invalidate.
 *
 * @param {string} cleanedBody Body after cleanBody().
 * @returns {string} sha256 hex digest.
 */
export function contentHashOf(cleanedBody) {
  return createHash('sha256').update(cleanedBody.replace(/\r\n/g, '\n').trim()).digest('hex')
}
//#endregion
/**
 * Report distillation coverage per root WITHOUT distilling anything.
 *
 * This is the read-only half of the ledger: the same set difference the pass uses,
 * minus the model calls. It answers "which documents have no distilled content?"
 * and is cheap enough to run from the settings page.
 *
 * @param {{roots: string[], store: string}} options Roots and store directory.
 * @returns {{roots: Array<object>, scanned: number, distilled: number, pending: number}} Coverage.
 */
export function computeCoverage(options) {
  const { roots, store } = options;
  const ledger = new DistillLedger(store);
  const summary = { roots: [], scanned: 0, distilled: 0, pending: 0 };

  for (const root of roots) {
    const entry = { root, scanned: 0, distilled: 0, pending: 0, pendingFiles: [], orphanedInsights: 0 };
    let files = [];
    try {
      files = scanMarkdown(root);
    } catch (error) {
      entry.error = String(error?.message ?? error);
      summary.roots.push(entry);
      continue;
    }

    const state = ledger.load(root);
    const liveHashes = new Set();
    for (const file of files) {
      let raw;
      try {
        raw = readFileSync(file.abs, 'utf8');
      } catch { continue; }
      const body = cleanBody(raw);
      if (body.length < 80) continue;
      const hash = contentHashOf(body);
      liveHashes.add(hash);
      entry.scanned += 1;
      if (state.entries[hash] === undefined) {
        entry.pending += 1;
        // Cap the list: the page shows a sample, the count is authoritative.
        if (entry.pendingFiles.length < 200) entry.pendingFiles.push(file.rel);
      } else {
        entry.distilled += 1;
      }
    }

    // Ledger entries whose content is gone: their insights are now orphans.
    for (const [hash, record] of Object.entries(state.entries)) {
      if (liveHashes.has(hash)) continue;
      entry.orphanedInsights += Array.isArray(record?.insights) ? record.insights.length : 0;
    }

    summary.scanned += entry.scanned;
    summary.distilled += entry.distilled;
    summary.pending += entry.pending;
    summary.roots.push(entry);
  }
  return summary;
}
/**
 * Run one distillation pass across the configured roots.
 *
 * Never throws: a failure in distillation must not disturb the Documents sync
 * that shares this process.
 *
 * @param {object} options Run options.
 * @param {number} [options.concurrency] How many notes to distil at once, clamped
 *   to [1, DISTILL_CONCURRENCY_MAX]. 1 is the pre-0.5.4 serial behaviour.
 * @param {(event: object) => void} [options.onEvent] Progress observer; see emit() below.
 *   Receives {type: 'root'|'note-start'|'note-done'|'note-failed', ...}. Never throws.
 * @returns {Promise<object>} A report of what happened.
 */
export async function runDistillPass(options) {
  const {
    roots, store, complete, log,
    maxFilesPerRun = 10,
    maxInsightsPerFile = 4,
    // How many notes may be distilled at once. 1 restores the strictly-serial
    // behaviour of 0.5.3 exactly; anything else is clamped to
    // [1, DISTILL_CONCURRENCY_MAX] by normalizeConcurrency().
    concurrency = DISTILL_CONCURRENCY_DEFAULT,
    dryRun = false,
    // Optional: (insight) => Promise<void|string[]>. Owned by the caller, which knows
    // the CLI path and enforces the 8,000-byte clamp. Without it the pass still
    // distils, but every proposal is counted as `dropped` rather than written.
    persistInsight,
    // Optional: (event) => void. Progress observer, called synchronously as the
    // pass advances. The Settings page subscribes to it through lib/events.js,
    // so what a page shows is what the pass is actually doing - not a snapshot
    // taken when the page opened, and not a timer re-deriving it.
    onEvent,
  } = options;

  /** Report progress without letting a broken observer abort the pass. */
  const emit = (event) => {
    if (typeof onEvent !== 'function') return;
    try { onEvent(event); } catch { /* observation never breaks the work */ }
  };

  const ledger = new DistillLedger(store);
  // `dropped` is not a failure: it is the honest count of conclusions this pass
  // produced but did not persist, so the UI can say so instead of implying a write.
  const report = {
    roots: [], proposed: 0, persisted: 0, dropped: 0, files: 0, skipped: 0,
    alreadyDone: 0, stale: 0, errors: [],
  };
  const seen = new Set();
  let budget = maxFilesPerRun;

  for (const root of roots) {
    const entry = { root, scanned: 0, pending: 0, alreadyDone: 0, distilled: 0, note: undefined };
    report.roots.push(entry);

    // ---- 1. Enumerate the vault and fingerprint every note's cleaned body. ----
    let files = [];
    try {
      files = scanMarkdown(root);
    } catch (error) {
      report.errors.push({ root, error: String(error?.message ?? error) });
      entry.note = 'scan failed';
      continue;
    }
    entry.scanned = files.length;

    /** @type {Array<{rel: string, hash: string, body: string}>} */
    const live = [];
    for (const file of files) {
      let raw;
      try {
        raw = readFileSync(file.abs, 'utf8');
      } catch { continue; }
      const body = cleanBody(raw);
      if (body.length < 80) continue;
      live.push({ rel: file.rel, hash: contentHashOf(body), body });
    }

    // ---- 2. The whole decision: which live hashes have NO ledger entry? ----
    //
    // This is a set difference against the ledger, not a comparison against a
    // timestamp. A note that was never distilled is simply absent from `entries`,
    // regardless of whether it is new, edited, or ancient.
    const state = ledger.load(root);
    const liveHashes = new Set(live.map((n) => n.hash));
    const pending = live.filter((note) => state.entries[note.hash] === undefined)
      .sort((a, b) => a.rel.localeCompare(b.rel));
    entry.alreadyDone = live.length - pending.length;
    entry.pending = pending.length;
    report.alreadyDone += entry.alreadyDone;

    // ---- 3. Forget entries whose content is gone from the vault. ----
    // Not required for correctness (a vanished note costs nothing to ignore), but it
    // keeps the ledger proportional to the vault instead of growing forever.
    if (!dryRun) {
      const removed = ledger.prune(root, liveHashes);
      if (removed > 0) report.stale += removed;
    }

    if (pending.length === 0) {
      entry.note = 'all notes already distilled';
      if (!dryRun) ledger.save(root);
      continue;
    }
    if (budget <= 0) {
      entry.note = 'run budget exhausted, ' + pending.length + ' pending';
      continue;
    }

    // ---- 4. Distil the backlog, oldest-first is meaningless here: use path order, --
    // which is stable, so a capped run always resumes where the last one stopped. ----
    const batch = pending.slice(0, budget);
    budget -= batch.length;
    entry.note = 'distilling ' + batch.length + ' of ' + pending.length + ' pending';
    emit({ type: 'root', root, pending: pending.length, batch: batch.length });

    // ---- 5. Distil the batch through a bounded worker pool. ----
    //
    // Before 0.5.4 this was a plain `for await`: one note, one model call, next.
    // With a 389-file vault and a 7-25 s call that is the entire wall clock, so
    // `concurrency` workers pull from the same batch queue and the pass finishes
    // in roughly 1/N of the time up to the provider's own limit.
    //
    // The pool is deliberately dumb: N workers each loop `take()` → work → repeat.
    // No barrier, no per-worker state, no ordering guarantee. Everything shared
    // (`report`, `seen`, `entry`, the ledger cache) is mutated in synchronous
    // segments only, so no lock is needed and no two workers can interleave inside
    // one update — but nothing may yield *between* a check and its mutation either,
    // which is why the dedupe and the counters below sit in the same tick.
    const workers = Math.max(1, normalizeConcurrency(concurrency));
    const queue = batch.slice();
    // Which notes are in flight right now, keyed by path so a retry of the same
    // note cannot double-count. Carried on every event as `active`/`files` so the
    // caller renders the real concurrent set instead of guessing from the last
    // `note-start` it happened to see (which was enough when only one could run).
    /** @type {Map<string, {file: string, bytes: number, startedAt: number}>} */
    const running = new Map();
    /** Snapshot of `running` for an event; cheap because the pool is bounded. */
    const inFlight = () => Array.from(running.values());

    const distilOne = async (note) => {
      // Published BEFORE the model call, so a page opened mid-call names the note
      // being worked on instead of the previous one.
      const bytes = Buffer.byteLength(note.body, 'utf8');
      running.set(note.rel, { file: note.rel, bytes, startedAt: Date.now() });
      emit({
        type: 'note-start',
        root,
        file: note.rel,
        bytes,
        active: running.size,
        files: inFlight(),
      });
      let insights;
      try {
        insights = await distillWithModel(complete, note.rel, note.body, { maxInsights: maxInsightsPerFile });
      } catch (error) {
        // Deliberately NOT recorded in the ledger: an error must leave the note
        // pending so the next pass retries it. This is what makes the ledger
        // self-healing rather than a one-shot marker.
        running.delete(note.rel);
        const message = String(error?.message ?? error);
        report.errors.push({ root, file: note.rel, error: message });
        emit({ type: 'note-failed', root, file: note.rel, error: message, active: running.size, files: inFlight() });
        return;
      }

      report.files += 1;
      const produced = [];
      for (const insight of insights) {
        const key = contentKey(insight.content);
        // Check-and-add in one tick: with N workers 'seen' is the only thing
        // stopping the same claim being written twice from two different notes.
        if (seen.has(key)) continue;
        seen.add(key);
        report.proposed += 1;
        if (log !== undefined) log('[distill] ' + note.rel + ' -> ' + insight.content.slice(0, 60));

        if (typeof persistInsight === 'function' && !dryRun) {
          try {
            const ids = await persistInsight({
              content: insight.content,
              category: insight.category,
              importance: insight.importance,
              tags: insight.tags,
              entities: insight.entities,
              source: note.rel,
              root,
            });
            report.persisted += 1;
            for (const id of Array.isArray(ids) ? ids : []) produced.push(id);
          } catch (error) {
            report.errors.push({ root, file: note.rel, error: 'persist: ' + String(error?.message ?? error) });
          }
        } else {
          report.dropped += 1;
        }
      }

      // Record the note ONLY after its insights were handled. A note that produced
      // nothing (no durable claim) is still recorded: re-asking the model on every
      // pass would burn quota forever for the same empty answer.
      if (!dryRun) {
        ledger.mark(root, note.hash, {
          rel: note.rel,
          bytes: Buffer.byteLength(note.body, 'utf8'),
          insights: produced,
          distilled: insights.length,
          at: new Date().toISOString(),
        });
        entry.distilled += 1;
      }
      running.delete(note.rel);
      // Two different numbers, kept apart because they diverge when the sink
      // rejects or dedupes: what the model proposed, and what the store accepted.
      emit({
        type: 'note-done',
        root,
        file: note.rel,
        proposed: insights.length,
        written: produced.length,
        active: running.size,
        files: inFlight(),
      });
    };

    /** One worker: pull the next note until the batch is empty. */
    const runWorker = async () => {
      for (;;) {
        const note = queue.shift();
        if (note === undefined) return;
        await distilOne(note);
      }
    };

    // `distilOne` swallows its own model and persist failures, so a worker cannot
    // reject; Promise.all is safe and is also the join point before the ledger save.
    await Promise.all(Array.from({ length: Math.min(workers, batch.length) }, () => runWorker()));

    if (!dryRun) ledger.save(root);
  }

  return report;
}
