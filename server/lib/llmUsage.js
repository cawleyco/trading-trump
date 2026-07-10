// Per-call LLM token accounting. Every anthropic.messages.create call site
// reports its response usage here so token spend (and prompt-cache behavior)
// is observable via logs and GET /api/cache/stats.

import { log } from '../logger.js';

const totals = new Map(); // tag → { calls, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens }

export function logLlmUsage(tag, usage) {
  if (!usage) return;
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
  let t = totals.get(tag);
  if (!t) totals.set(tag, (t = { calls: 0, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }));
  t.calls += 1;
  t.inputTokens += inputTokens;
  t.outputTokens += outputTokens;
  t.cacheCreationTokens += cacheCreationTokens;
  t.cacheReadTokens += cacheReadTokens;
  log.info('llm-usage', tag, {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens: cacheCreationTokens,
    cache_read_input_tokens: cacheReadTokens,
  });
}

/** Process-lifetime totals per tag, for /api/cache/stats. */
export function llmUsageTotals() {
  return Object.fromEntries(totals);
}
