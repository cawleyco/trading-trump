// Per-call LLM token accounting. Every anthropic.messages.create call site
// reports its response usage here so token spend (and prompt-cache behavior)
// is observable via logs, GET /api/llm/usage, and GET /api/cache/stats.

import { log } from '../logger.js';

const RECENT_LIMIT = 50;

const totals = new Map(); // tag → { calls, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens }
const recent = []; // newest first; capped at RECENT_LIMIT

function cleanSubject(subject) {
  if (!subject || typeof subject !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(subject)) {
    if (v == null || v === '') continue;
    out[k] = typeof v === 'string' ? v : String(v);
  }
  return out;
}

export function logLlmUsage(tag, usage, subject = {}) {
  if (!usage) return;
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
  const cleaned = cleanSubject(subject);
  let t = totals.get(tag);
  if (!t) totals.set(tag, (t = { calls: 0, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }));
  t.calls += 1;
  t.inputTokens += inputTokens;
  t.outputTokens += outputTokens;
  t.cacheCreationTokens += cacheCreationTokens;
  t.cacheReadTokens += cacheReadTokens;
  const entry = {
    ts: new Date().toISOString(),
    tag,
    subject: cleaned,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens: cacheCreationTokens,
    cache_read_input_tokens: cacheReadTokens,
  };
  recent.unshift(entry);
  if (recent.length > RECENT_LIMIT) recent.length = RECENT_LIMIT;
  log.info('llm-usage', tag, {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens: cacheCreationTokens,
    cache_read_input_tokens: cacheReadTokens,
    ...cleaned,
  });
}

/** Process-lifetime totals per tag. */
export function llmUsageTotals() {
  return Object.fromEntries(totals);
}

/** Process-lifetime recent calls, newest first (max 50). */
export function llmUsageRecent() {
  return recent.slice();
}

/** Session-wide call count across all tags. */
export function llmUsageCallCount() {
  let n = 0;
  for (const t of totals.values()) n += t.calls;
  return n;
}

/** Test helper — clears totals and recent. */
export function _resetLlmUsage() {
  totals.clear();
  recent.length = 0;
}
