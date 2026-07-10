import test from 'node:test'
import assert from 'node:assert/strict'
import { config } from '../server/config.js'
import { db, createMentionClassification, getLatestAutoMentionClassification } from '../server/db.js'
import { classifyAndStoreYoutubeMention } from '../server/influence/youtubeMentionClassifier.js'

// A large fake mention id keeps these rows disjoint from real data; each test
// deletes what it seeded. FK checks are suspended while seeding so no real
// asset_mentions chain is required.
const FAKE_MENTION_ID = 987_654_321

function seedClassification(overrides = {}) {
  db.pragma('foreign_keys = OFF')
  try {
    return createSeedRow(overrides)
  } finally {
    db.pragma('foreign_keys = ON')
  }
}

function createSeedRow(overrides = {}) {
  return createMentionClassification({
    mention_id: FAKE_MENTION_ID,
    direction: 'bullish',
    conviction_score: 80,
    relevance_score: 90,
    directness_score: 85,
    sponsorship_risk_score: 5,
    pump_risk_score: 10,
    time_horizon: 'weeks',
    mention_type: 'direct_recommendation',
    summary: 'Seeded for dedup test.',
    evidence: ['quote'],
    should_create_signal: true,
    model_name: 'anthropic',
    model_version: config.sentimentModel,
    prompt_version: 'youtube-mention-v1',
    is_manual_override: false,
    ...overrides,
  })
}

function cleanup() {
  db.prepare('DELETE FROM mention_classifications WHERE mention_id = ?').run(FAKE_MENTION_ID)
}

test('classifyAndStoreYoutubeMention reuses the stored classification instead of re-calling the LLM', async (t) => {
  t.after(cleanup)
  // Belt and braces: even if the dedup guard regresses, the LLM path stays off.
  const llmWasEnabled = config.influence.llmClassificationEnabled
  config.influence.llmClassificationEnabled = false
  t.after(() => { config.influence.llmClassificationEnabled = llmWasEnabled })

  const seeded = seedClassification()
  const before = db.prepare('SELECT COUNT(*) AS n FROM mention_classifications WHERE mention_id = ?')
    .get(FAKE_MENTION_ID).n

  const result = await classifyAndStoreYoutubeMention({ id: FAKE_MENTION_ID, symbol: 'TSLA' })
  assert.equal(result.reused, true)
  assert.equal(result.id, seeded.id)
  assert.equal(result.summary, 'Seeded for dedup test.')

  const after = db.prepare('SELECT COUNT(*) AS n FROM mention_classifications WHERE mention_id = ?')
    .get(FAKE_MENTION_ID).n
  assert.equal(after, before) // no duplicate row inserted
})

test('manual overrides and other model/prompt versions do not satisfy the dedup guard', async (t) => {
  t.after(cleanup)

  seedClassification({ is_manual_override: true })
  seedClassification({ model_version: 'some-other-model' })
  seedClassification({ prompt_version: 'youtube-mention-v0' })
  assert.equal(
    getLatestAutoMentionClassification(FAKE_MENTION_ID, config.sentimentModel, 'youtube-mention-v1'),
    null
  )

  const match = seedClassification()
  const found = getLatestAutoMentionClassification(FAKE_MENTION_ID, config.sentimentModel, 'youtube-mention-v1')
  assert.equal(found.id, match.id)
})

test('force bypasses the guard (LLM disabled here, so it returns null rather than reusing)', async (t) => {
  t.after(cleanup)
  const llmWasEnabled = config.influence.llmClassificationEnabled
  config.influence.llmClassificationEnabled = false
  t.after(() => { config.influence.llmClassificationEnabled = llmWasEnabled })

  seedClassification()
  const result = await classifyAndStoreYoutubeMention(
    { id: FAKE_MENTION_ID, symbol: 'TSLA' },
    { force: true }
  )
  assert.equal(result, null) // guard skipped; disabled LLM path returns null
})
