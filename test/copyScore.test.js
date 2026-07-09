import test from 'node:test'
import assert from 'node:assert/strict'
import { computeCopyScore } from '../server/intel/copyScore.js'

const baseTrade = {
  trade_key: 'Jane Doe|ABC|2026-07-01|buy|$50,001 - $100,000',
  politician: 'Jane Doe',
  ticker: 'ABC',
  type: 'buy',
  transaction_date: '2026-07-01',
  disclosure_date: '2026-07-04',
  first_seen_at: '2026-07-04 12:00:00',
  amount_mid: 75_000,
  owner: 'self',
  is_option: 0,
  parse_confidence: 1,
}

test('computeCopyScore returns a high-confidence copy candidate from strong inputs', () => {
  const result = computeCopyScore(baseTrade, {
    now: '2026-07-05T00:00:00Z',
    politicianStats: { edge_score: 88, buy_count: 20, stats: { measurable_buys_90d: 20 } },
    driftPct: 1.5,
    avgDollarVolume: 75_000_000,
    clusterCount: 4,
    repeatBuyCount: 1,
    relevanceScore: 70,
    relevanceSignals: [{ text: 'Committee sector match.' }],
  })

  assert.equal(result.recommendation, 'copy-candidate')
  assert.ok(result.score >= 75)
  assert.ok(result.confidence >= 0.9)
  assert.equal(result.factors.conviction.score, 75)
  assert.equal(result.factors.cluster.score, 90)
  assert.deepEqual(result.warnings, [])
})

test('stale and already-priced-in critical warnings force avoid', () => {
  const result = computeCopyScore(baseTrade, {
    now: '2026-08-25T00:00:00Z',
    politicianStats: { edge_score: 92, buy_count: 20, stats: { measurable_buys_90d: 20 } },
    driftPct: 22,
    avgDollarVolume: 100_000_000,
    clusterCount: 4,
    relevanceScore: 70,
  })

  assert.equal(result.recommendation, 'avoid')
  assert.equal(result.warnings.find((w) => w.code === 'stale-filing')?.severity, 'critical')
  assert.equal(result.warnings.find((w) => w.code === 'already-priced-in')?.severity, 'critical')
  assert.equal(result.factors.alreadyMoved.score, 10)
})

test('low parse confidence alone maps to manual review', () => {
  const result = computeCopyScore({ ...baseTrade, parse_confidence: 0.6 }, {
    now: '2026-07-05T00:00:00Z',
    politicianStats: { edge_score: 80, buy_count: 20, stats: { measurable_buys_90d: 20 } },
    driftPct: 1,
    avgDollarVolume: 75_000_000,
    clusterCount: 4,
    relevanceScore: 70,
  })

  assert.equal(result.recommendation, 'manual-review')
  assert.deepEqual(result.warnings.map((w) => w.code), ['low-parse-confidence'])
})

test('missing data lowers confidence but keeps neutral factor scores', () => {
  const result = computeCopyScore({ ...baseTrade, transaction_date: null, disclosure_date: null, first_seen_at: null }, {
    now: '2026-07-05T00:00:00Z',
    clusterCount: 1,
  })

  assert.equal(result.factors.freshness.hasData, false)
  assert.equal(result.factors.politicianEdge.score, 50)
  assert.equal(result.factors.politicianEdge.hasData, false)
  assert.equal(result.factors.alreadyMoved.hasData, false)
  assert.equal(result.factors.liquidity.hasData, false)
  assert.equal(result.recommendation, 'manual-review')
  assert.ok(result.confidence < 0.5)
})

test('sell drift scoring mirrors buy scoring directionally', () => {
  const result = computeCopyScore({ ...baseTrade, type: 'sell' }, {
    now: '2026-07-05T00:00:00Z',
    politicianStats: { edge_score: 70, buy_count: 20, stats: { measurable_buys_90d: 20 } },
    driftPct: -6,
    avgDollarVolume: 20_000_000,
    clusterCount: 2,
    relevanceScore: 70,
  })

  assert.equal(result.factors.alreadyMoved.hasData, true)
  assert.ok(result.factors.alreadyMoved.score < 60)
  assert.equal(result.warnings.some((w) => w.code === 'already-priced-in'), false)
})

test('options trades are critical avoid warnings', () => {
  const result = computeCopyScore({ ...baseTrade, is_option: 1 }, {
    now: '2026-07-05T00:00:00Z',
    politicianStats: { edge_score: 80, buy_count: 20, stats: { measurable_buys_90d: 20 } },
    driftPct: 1,
    avgDollarVolume: 75_000_000,
    clusterCount: 4,
    relevanceScore: 70,
  })

  assert.equal(result.factors.liquidity.score, 10)
  assert.equal(result.warnings.find((w) => w.code === 'options-trade')?.severity, 'critical')
  assert.equal(result.recommendation, 'avoid')
})
