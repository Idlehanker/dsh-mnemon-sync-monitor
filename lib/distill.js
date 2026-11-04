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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { detectChanges, highWater, headCommit, scanMarkdown } from './changes.js';
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
  // Normalise BEFORE stripping. The original order stripped frontmatter before
  // normalising and only matched a bare LF fence, so a CRLF note kept its whole
  // YAML block and the model was asked to distil `tags:`/`aliases:` metadata.
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
 * Remove fenced code blocks from note text.
 *
 * An Obsidian note can be almost entirely a Dataview query -- template
 * scaffolding with no knowledge in it. Distilling that produced "the file contains
 * a Dataview TABLE query WHERE contains(file.etags...)", which describes syntax
 * rather than a fact about anything. A note that is ALL code collapses to empty
 * and is skipped.
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
  // Measured on the reference gateway with workbuddy/hy4free: ~12-20 s for a short
  // note but 220 s for a 12,000-character one, past the command timeout. A longer
  // note is better served by its next section than by an oversized single call.
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

/**
 * Run one distillation pass across the configured roots.
 *
 * Never throws: a failure in distillation must not disturb the Documents sync
 * that shares this process.
 *
 * @param {object} options Run options.
 * @returns {Promise<object>} A report of what happened.
 */
export async function runDistillPass(options) {
  const {
    roots, store, complete, log,
    maxFilesPerRun = 10,
    maxInsightsPerFile = 4,
    dryRun = false,
  } = options;

  const state = new DistillState(store);
  const report = { roots: [], proposed: 0, files: 0, skipped: 0, errors: [] };
  const seen = new Set();
  let budget = maxFilesPerRun;

  for (const root of roots) {
    if (budget <= 0) { report.roots.push({ root, note: "run budget exhausted" }); continue; }
    const prev = state.load(root);
    let detected;
    try {
      detected = detectChanges(root, prev);
    } catch (error) {
      report.errors.push({ root, error: String(error?.message ?? error) });
      continue;
    }

    const head = headCommit(root);
    // Advance the high-water mark by 1 ms past everything scanned in THIS pass.
    // Without the +1 the newest file sits exactly on the boundary and mtimeChanged
    // re-detects it forever, re-distilling the same note on every run.
    const hw = highWater(root) + 1;
    const entry = {
      root,
      mode: detected.mode,
      changed: detected.changed.length,
      note: detected.note,
    };
    report.roots.push(entry);

    if (detected.changed.length === 0) {
      if (!dryRun) {
        state.save(root, { commit: head ?? prev?.commit, highWaterMs: hw, updatedAt: new Date().toISOString() });
      }
      continue;
    }

    const candidates = detected.changed.filter((c) => c.status !== 'D').slice(0, budget);
    budget -= candidates.length;

    for (const change of candidates) {
      const abs = join(resolve(root), ...change.rel.split('/'));
      let body;
      try {
        body = cleanBody(readText(abs, 'utf8'));
      } catch {
        report.skipped += 1;
        continue;
      }
      if (body.length < 80) { report.skipped += 1; continue; }

      let insights;
      try {
        insights = await distillWithModel(complete, change.rel, body, { maxInsights: maxInsightsPerFile });
      } catch (error) {
        report.errors.push({ root, file: change.rel, error: String(error?.message ?? error) });
        continue;
      }

      report.files += 1;
      for (const insight of insights) {
        const key = contentKey(insight.content);
        if (seen.has(key)) continue;
        seen.add(key);
        report.proposed += 1;
        if (log !== undefined) log('[distill] ' + change.rel + ' -> ' + insight.content.slice(0, 60));
      }
    }

    if (!dryRun) {
      state.save(root, { commit: head ?? prev?.commit, highWaterMs: hw, updatedAt: new Date().toISOString() });
    }
  }

  return report;
}
