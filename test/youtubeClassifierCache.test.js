import test from 'node:test'
import assert from 'node:assert/strict'
import { config } from '../server/config.js'
import { db } from '../server/db.js'
import { defaultCache } from '../server/cache/computeCache.js'
import { classifyAndStoreYoutubeMention } from '../server/influence/youtubeMentionClassifier.js'

// Content-addressed layer: a re-detected mention gets a FRESH id (so the
// per-mention-id reuse misses) but identical prompt inputs must hit the
// compute cache instead of re-calling the LLM.

const NAMESPACE = 'youtube-mention-classify'
const PROMPT_VERSION = 'youtube-mention-v1'
const FAKE_MENTION_ID = 987_654_400

function mentionWithId(id) {
  return {
    id,
    symbol: 'TSLA',
    canonical_name: 'Tesla Inc.',
    surrounding_text: 'I am doubling my Tesla position right here.',
    mention_start_seconds: 42,
    entity_confidence: 0.9,
  }
}

function cacheKeyParts(mention) {
  // Mirrors the keyParts built in classifyAndStoreYoutubeMention.
  return {
    model: config.sentimentModel,
    symbol: mention.symbol,
    name: mention.canonical_name,
    segment: mention.surrounding_text,
    before: '',
    after: '',
    channel: '',
    video: '',
    description: '',
    paid: false,
    startSeconds: mention.mention_start_seconds,
  }
}

const RAW_CLASSIFICATION = {
  direction: 'bullish',
  mentionType: 'direct_recommendation',
  timeHorizon: 'months',
  convictionScore: 85,
  relevanceScore: 90,
  directnessScore: 88,
  sponsorshipRiskScore: 5,
  pumpRiskScore: 10,
  summary: 'Creator is adding to a long position.',
  evidence: ['doubling my Tesla position'],
  shouldCreateSignal: true,
}

test('identical prompt inputs under a fresh mention id are served from the compute cache', async (t) => {
  const cache = await defaultCache()
  const mention = mentionWithId(FAKE_MENTION_ID)
  t.after(() => {
    db.prepare('DELETE FROM mention_classifications WHERE mention_id = ?').run(FAKE_MENTION_ID)
    cache.invalidate(NAMESPACE, cacheKeyParts(mention), { version: PROMPT_VERSION })
  })

  // Simulate an earlier run having paid for this exact content.
  cache.set(NAMESPACE, cacheKeyParts(mention), RAW_CLASSIFICATION, { version: PROMPT_VERSION })

  // LLM stays off: if the cache misses, the compute returns null and the
  // assertion below fails — proof the result came from the cache.
  const llmWasEnabled = config.influence.llmClassificationEnabled
  config.influence.llmClassificationEnabled = false
  db.pragma('foreign_keys = OFF')
  let classification
  try {
    classification = await classifyAndStoreYoutubeMention(mention)
  } finally {
    db.pragma('foreign_keys = ON')
    config.influence.llmClassificationEnabled = llmWasEnabled
  }

  assert.ok(classification, 'classification produced without any LLM call')
  assert.equal(classification.direction, 'bullish')
  assert.equal(classification.mention_type, 'direct_recommendation')
  assert.equal(classification.prompt_version, PROMPT_VERSION)
})

test('different prompt content misses the cache (no cross-contamination)', async (t) => {
  const cache = await defaultCache()
  const mention = mentionWithId(FAKE_MENTION_ID + 1)
  mention.surrounding_text = 'Completely different sentence about Tesla.'
  t.after(() => {
    db.prepare('DELETE FROM mention_classifications WHERE mention_id = ?').run(mention.id)
  })

  const llmWasEnabled = config.influence.llmClassificationEnabled
  config.influence.llmClassificationEnabled = false
  db.pragma('foreign_keys = OFF')
  let classification
  try {
    classification = await classifyAndStoreYoutubeMention(mention)
  } finally {
    db.pragma('foreign_keys = ON')
    config.influence.llmClassificationEnabled = llmWasEnabled
  }

  assert.equal(classification, null, 'cache miss + LLM disabled yields null, and null is never cached')
  const hit = cache.get(NAMESPACE, cacheKeyParts(mention), { version: PROMPT_VERSION })
  assert.equal(hit.hit, false)
})
