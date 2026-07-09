import test from 'node:test'
import assert from 'node:assert/strict'
import { makeTradeSignal } from '../server/signal.js'
import { isMarketRelevant, normalizeClassification } from '../server/sentiment/classifier.js'
import { planPostClassification } from '../server/sources/truthSocialPoller.js'

test('accepts a valid buy signal and normalizes the ticker', () => {
  const s = makeTradeSignal({
    source: 'congress',
    ticker: ' nvda ',
    direction: 'buy',
    rationale: 'test',
  })
  assert.equal(s.ticker, 'NVDA')
  assert.equal(s.direction, 'buy')
  assert.equal(s.confidence, null)
})

test('rejects invalid sources, directions, tickers and confidence', () => {
  assert.throws(() => makeTradeSignal({ source: 'other', ticker: 'AAPL', direction: 'buy' }))
  assert.throws(() => makeTradeSignal({ source: 'congress', ticker: 'AAPL', direction: 'short' }))
  assert.throws(() => makeTradeSignal({ source: 'congress', ticker: '', direction: 'buy' }))
  assert.throws(() => makeTradeSignal({ source: 'congress', ticker: '123$', direction: 'buy' }))
  assert.throws(() =>
    makeTradeSignal({ source: 'sentiment', ticker: 'AAPL', direction: 'buy', confidence: 1.5 })
  )
})

test('allows dotted share classes like BRK.B', () => {
  const s = makeTradeSignal({ source: 'congress', ticker: 'BRK.B', direction: 'sell' })
  assert.equal(s.ticker, 'BRK.B')
})

test('normalizes extended sentiment classifier output', () => {
  const c = normalizeClassification({
    relevanceType: 'regulation',
    marketRelevance: 0.82,
    sectors: ['Energy', 'energy', ' utilities '],
    tickers: [
      { ticker: ' xle ', direction: 'buy', confidence: 0.7, rationale: 'Energy policy tailwind.' },
      { ticker: 'bad', direction: 'short', confidence: 0.9 },
    ],
    rationale: 'Direct regulatory impact.',
  })

  assert.equal(c.relevanceType, 'regulation')
  assert.equal(c.marketRelevance, 0.82)
  assert.deepEqual(c.sectors, ['energy', 'utilities'])
  assert.deepEqual(c.tickers, [
    { ticker: 'XLE', direction: 'buy', confidence: 0.7, rationale: 'Energy policy tailwind.' },
  ])
  assert.equal(isMarketRelevant(c, 0.5), true)
})

test('opinion and low-relevance sentiment classifications do not pass the signal gate', () => {
  assert.equal(isMarketRelevant(normalizeClassification({
    relevanceType: 'opinion',
    marketRelevance: 0.9,
    tickers: [{ ticker: 'AAPL', direction: 'buy', confidence: 0.8 }],
  })), false)

  assert.equal(isMarketRelevant(normalizeClassification({
    relevanceType: 'company',
    marketRelevance: 0.2,
    tickers: [{ ticker: 'AAPL', direction: 'buy', confidence: 0.8 }],
  })), false)
})

test('truth social first poll classifies seed posts without allowing trades', () => {
  const plan = planPostClassification({
    post: { createdAt: '2026-07-08T12:00:00.000Z' },
    seenPost: null,
    firstRun: true,
    now: new Date('2026-07-09T12:00:00.000Z').getTime(),
    maxAgeMs: 15 * 60_000,
  })

  assert.equal(plan.action, 'classify')
  assert.equal(plan.shouldTrade, false)
})

test('truth social poller skips already-classified posts', () => {
  const plan = planPostClassification({
    post: { createdAt: '2026-07-09T11:55:00.000Z' },
    seenPost: { classification: { relevanceType: 'company' } },
    firstRun: false,
    now: new Date('2026-07-09T12:00:00.000Z').getTime(),
    maxAgeMs: 15 * 60_000,
  })

  assert.equal(plan.action, 'skip')
  assert.equal(plan.reason, 'already-classified')
})

test('truth social poller retries fresh unclassified posts but skips stale ones after startup', () => {
  const now = new Date('2026-07-09T12:00:00.000Z').getTime()

  const fresh = planPostClassification({
    post: { createdAt: '2026-07-09T11:55:00.000Z' },
    seenPost: { classification: null },
    firstRun: false,
    now,
    maxAgeMs: 15 * 60_000,
  })
  assert.equal(fresh.action, 'classify')
  assert.equal(fresh.shouldTrade, true)

  const stale = planPostClassification({
    post: { createdAt: '2026-07-09T11:30:00.000Z' },
    seenPost: { classification: null },
    firstRun: false,
    now,
    maxAgeMs: 15 * 60_000,
  })
  assert.equal(stale.action, 'skip')
  assert.equal(stale.reason, 'stale')
})
