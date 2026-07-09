import test from 'node:test'
import assert from 'node:assert/strict'
import { buildThesisCard } from '../server/intel/thesisCard.js'

const fullTrade = {
  trade_key: 'Jane Doe|NVDA|2026-06-20|buy|$50,001 - $100,000',
  politician: 'Rep. Jane Doe',
  ticker: 'NVDA',
  type: 'buy',
  transaction_date: '2026-06-20',
  disclosure_date: '2026-06-27',
  amount_min: 50_001,
  amount_max: 100_000,
  amount_mid: 75_000,
  amount_range: '$50,001 - $100,000',
  owner: 'self',
  is_option: 0,
  parse_confidence: 1,
}

const fullScore = {
  score: 82,
  confidence: 0.86,
  recommendation: 'copy-candidate',
  factors: {
    committeeRelevance: { score: 70, weight: 5, detail: 'Sits on House Armed Services.', hasData: true },
  },
  warnings: [],
}

const fullCtx = {
  driftPct: 3.1,
  sinceDisclosurePct: 1.2,
  repeatBuyCount: 2,
  clusterCount: 3,
  politicianStats: { edge_score: 78 },
}

test('buildThesisCard assembles every section from a full context', () => {
  const card = buildThesisCard(fullTrade, fullScore, fullCtx)

  assert.equal(card.what, 'Rep. Jane Doe purchased NVDA ($50k–$100k) on 2026-06-20, disclosed 2026-06-27.')
  // repeat buy (3rd), cluster, sizeable position, committee relevance
  assert.ok(card.whyItMatters.some((s) => s.includes('3rd NVDA buy')))
  assert.ok(card.whyItMatters.some((s) => s.includes('3 members traded NVDA')))
  assert.ok(card.whyItMatters.some((s) => s.includes('Armed Services')))
  assert.equal(card.sinceThen, 'NVDA is up 3.1% since the trade date and up 1.2% since disclosure.')
  assert.equal(card.signal.copyScore, 82)
  assert.equal(card.signal.recommendation, 'copy-candidate')
  assert.ok(card.signal.politicianEdge.includes('Top-quartile'))
  assert.deepEqual(card.risks, ['Disclosure lag of 7 days.'])
  assert.equal(card.suggestedAction, 'copy-candidate')
})

test('buildThesisCard omits missing-data sections without printing undefined', () => {
  const sparseTrade = {
    politician: 'Doe, John',
    ticker: 'ABC',
    type: 'sell',
    disclosure_date: '2026-05-01',
    is_option: 0,
  }
  const sparseScore = { score: 40, confidence: 0.4, recommendation: 'manual-review', factors: {}, warnings: [] }
  const card = buildThesisCard(sparseTrade, sparseScore, {})

  assert.equal(card.what, 'Doe, John sold ABC, disclosed 2026-05-01.')
  assert.ok(!card.what.includes('undefined'))
  assert.deepEqual(card.whyItMatters, [])
  assert.equal(card.sinceThen, null)
  assert.equal(card.signal.politicianEdge, undefined)
  assert.deepEqual(card.risks, [])
  assert.equal(card.suggestedAction, 'manual-review')
})

test('buildThesisCard surfaces warnings and option risk, dropping the duplicate options warning', () => {
  const optTrade = {
    politician: 'Sen. Foo',
    ticker: 'LMT',
    type: 'buy',
    transaction_date: '2026-04-01',
    disclosure_date: '2026-04-05',
    amount_mid: 5_000,
    is_option: 1,
    option_detail: JSON.stringify({ type: 'call', strike: 400, expiry: '2026-09-18' }),
  }
  const score = {
    score: 30,
    confidence: 0.7,
    recommendation: 'avoid',
    factors: {},
    warnings: [
      { code: 'options-trade', severity: 'critical', message: 'Options disclosures are never auto-tradable.' },
      { code: 'low-conviction', severity: 'caution', message: 'Small disclosed amount with no recent repeat buy.' },
    ],
  }
  const card = buildThesisCard(optTrade, score, { driftPct: -2 })

  assert.ok(card.risks.includes('Options position expiring 2026-09-18.'))
  assert.ok(card.risks.includes('Small disclosed amount with no recent repeat buy.'))
  assert.ok(!card.risks.some((r) => r.includes('never auto-tradable')))
  assert.equal(card.sinceThen, 'LMT is down 2% since the trade date.')
})

test('buildThesisCard uses raw amount_range when min/max are absent', () => {
  const t = { politician: 'X', ticker: 'AAA', type: 'buy', amount_range: '$1,001 - $15,000' }
  const card = buildThesisCard(t, {}, {})
  assert.ok(card.what.includes('($1,001 - $15,000)'))
})
