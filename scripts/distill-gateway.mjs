#!/usr/bin/env node
/**
 * distill-gateway - the model call the distill scheduler shells out to.
 *
 * Contract expected by lib/index.js completeVia(): read JSON from stdin
 * ({ "messages": [...] }), write the assistant text to stdout, exit 0.
 *
 * WHY A SEPARATE PROCESS
 * The plugin is plain ESM inside the Host and must not carry HTTP client state,
 * credentials, or retry policy. A short-lived child keeps that boundary: the
 * Host hands over the messages, this script talks to the gateway, then exits.
 *
 * WHICH GATEWAY
 * DSH runs an OpenAI-compatible endpoint on a loopback port with a bearer key in
 * ~/.dsh/openai-gateway/api-key (measured: /v1/models returned 200 with the key,
 * 401 without it). Discovery order below, first that answers /v1/models wins.
 *
 * CONFIG (env, all optional)
 *   DISTILL_BASE_URL   e.g. http://127.0.0.1:8326/v1   (skips discovery)
 *   DISTILL_API_KEY    bearer token (defaults to the gateway key file)
 *   DISTILL_MODEL      model id (default: workbuddy/hy4free, then first chat model)
 *   DISTILL_EFFORT     reasoning effort (low|medium|high|...); omitted = model default
 *   DISTILL_TIMEOUT_MS request timeout, default 120000
 *
 * Exit: 0 ok, 1 no endpoint / request failed, 2 bad input.
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Ports DSH has been observed to bind for its local gateways. */
const CANDIDATE_PORTS = [8326, 15321, 15320, 15319];

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

/** The gateway writes its bearer key here; absent on a machine without one. */
function gatewayKey() {
  if (typeof process.env.DISTILL_API_KEY === 'string' && process.env.DISTILL_API_KEY.trim() !== '') {
    return process.env.DISTILL_API_KEY.trim();
  }
  const p = join(homedir(), '.dsh', 'openai-gateway', 'api-key');
  try {
    if (!existsSync(p)) return undefined;
    const k = readFileSync(p, 'utf8').trim();
    return k === "" ? undefined : k;
  } catch { return undefined; }
}

/** Ask a base URL for its model list; returns the ids or undefined. */
async function listModels(baseUrl, key, timeoutMs) {
  try {
    const res = await fetch(baseUrl + "/models", {
      headers: key === undefined ? {} : { Authorization: "Bearer " + key },
      signal: AbortSignal.timeout(Math.min(timeoutMs, 10000)),
    });
    if (!res.ok) return undefined;
    const body = await res.json();
    const ids = Array.isArray(body?.data) ? body.data.map((m) => m?.id).filter((x) => typeof x === 'string') : [];
    return ids;
  } catch { return undefined; }
}

/** Find the first loopback gateway that answers, and its model ids. */
async function discover(key, timeoutMs) {
  const explicit = typeof process.env.DISTILL_BASE_URL === 'string' ? process.env.DISTILL_BASE_URL.trim() : '';
  const bases = explicit !== '' ? [explicit] : CANDIDATE_PORTS.map((p) => 'http://127.0.0.1:' + p + '/v1');
  for (const base of bases) {
    const ids = await listModels(base, key, timeoutMs);
    if (ids !== undefined && ids.length > 0) return { base, ids };
  }
  return undefined;
}

/**
 * Pick the distillation model.
 *
 * Preference order (checked 2026-11-04 against /v1/models):
 *   1. DISTILL_MODEL, when set.
 *   2. workbuddy/hy4free - Hy4 at x0.00, the limited-time free tier. Distillation
 *      runs on every changed file in the background, so the free route is the
 *      only sane default; hy4std (x0.29) and hy4-preview are paid siblings.
 *   3. any chat-capable model that is not an embedding model.
 *
 * All three Hy4 routes answered normally on this machine, so this is a cost
 * choice, not a capability one.
 */
const PREFERRED_MODEL = 'workbuddy/hy4free';

function pickModel(ids) {
  const configured = typeof process.env.DISTILL_MODEL === 'string' ? process.env.DISTILL_MODEL.trim() : '';
  if (configured !== '') return configured;
  if (ids.includes(PREFERRED_MODEL)) return PREFERRED_MODEL;
  const notEmbedding = ids.filter((id) => !/embed/i.test(id));
  const pool = notEmbedding.length > 0 ? notEmbedding : ids;
  const flash = pool.find((id) => /flash|chat|instruct|turbo/i.test(id));
  return flash ?? pool[0];
}

/**
 * Reasoning effort to request, or undefined to let the adapter decide.
 *
 * Distillation is a background, per-note task whose answer is a short JSON list,
 * not a chain of deductions, so a high tier spends output budget on thinking that
 * the task does not need. Measured against the local gateway on
 * workbuddy/deepseek-v4.1-flash, 4 runs per tier, same ~1,200-character note:
 *
 *   effort   avg completion   avg reasoning chars   avg latency
 *   low      1,582            1,663                 7.2 s
 *   high     1,655            2,243                 7.2 s
 *   max      2,395            4,405                 10.1 s
 *
 * 'low' costs ~26% less reasoning and ~4% fewer completion tokens than the
 * model's own 'high' default, and ~34% fewer completion tokens than 'max'. A
 * single run is too noisy to read: an earlier one-off sample had 'low' producing
 * MORE reasoning than 'high', which is why these numbers are averaged.
 *
 * The value is forwarded VERBATIM rather than clamped or mapped: the gateway
 * validates it against the exact model and rejects an unsupported tier with a
 * 400 naming the allowed ones, so a silent fallback here would hide a real
 * configuration error behind a downgrade nobody asked for.
 */
function pickEffort() {
  const raw = typeof process.env.DISTILL_EFFORT === 'string' ? process.env.DISTILL_EFFORT.trim() : '';
  return raw === '' ? undefined : raw;
}

async function main() {
  const timeoutMs = Number(process.env.DISTILL_TIMEOUT_MS ?? 120000);
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch (error) {
    console.error("distill-gateway: stdin is not JSON: " + error.message);
    return 2;
  }
  const messages = Array.isArray(input?.messages) ? input.messages : undefined;
  if (messages === undefined) { console.error("distill-gateway: missing messages[]"); return 2; }

  const key = gatewayKey();
  const found = await discover(key, timeoutMs);
  if (found === undefined) {
    console.error("distill-gateway: no gateway answered. Set DISTILL_BASE_URL, or make sure DSH is running.");
    return 1;
  }
  const model = pickModel(found.ids);
  const effort = pickEffort();

  let res;
  try {
    res = await fetch(found.base + "/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(key === undefined ? {} : { Authorization: "Bearer " + key }),
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.2,
        // Absent, not null: the gateway treats a present-but-unknown value as an
        // error, and an explicit null is not the same request as omitting it.
        ...(effort === undefined ? {} : { reasoning_effort: effort }),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    console.error("distill-gateway: request failed: " + error.message);
    return 1;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error("distill-gateway: HTTP " + res.status + " " + text.slice(0, 200));
    return 1;
  }

  const body = await res.json().catch(() => undefined);
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim() === "") {
    console.error("distill-gateway: empty completion");
    return 1;
  }

  process.stdout.write(content);
  return 0;
}

main().then((code) => { process.exitCode = code }).catch((error) => {
  console.error("distill-gateway: " + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
