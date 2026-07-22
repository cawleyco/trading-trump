import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MIN_NARRATIVE_MENTIONS,
  windowStats,
  rawNarrativeMetrics,
  aggregateByNarrative,
} from '../server/influence/narrativeStats.js'
import {
  calculateRawReturn,
  calculateDirectionalReturn,
  _resultForMention,
} from '../server/backtest/youtubeBacktest.js'

function rows(n, abnormal, extra = {}) {
  return Array.from({ length: n }, () => ({
    entry_price: 100,
    abnormal_return_7d: abnormal,
    raw_return_7d: abnormal,
    ...extra,
  }))
}

test('windowStats reports insufficient below the minimum sample', () => {
  const s = windowStats(rows(MIN_NARRATIVE_MENTIONS - 1, 3), '7d')
  assert.equal(s.insufficient, true)
  assert.equal(s.measurable, MIN_NARRATIVE_MENTIONS - 1)
  assert.equal(s.avg_abnormal_return, undefined)
})

test('windowStats computes abnormal-return stats above the minimum sample', () => {
  const s = windowStats(rows(MIN_NARRATIVE_MENTIONS, 4), '7d')
  assert.equal(s.insufficient, false)
  assert.equal(s.avg_abnormal_return, 4)
  assert.equal(s.beat_market_rate, 1)
})

test('t-stat flags a mean distinguishable from zero', () => {
  // Tight positive cluster around +5 → large |t|, significant.
  const results = Array.from({ length: 20 }, (_, i) => ({
    entry_price: 100,
    abnormal_return_7d: 5 + (i % 2 ? 0.1 : -0.1),
    raw_return_7d: 5,
  }))
  const s = windowStats(results, '7d')
  assert.equal(s.significant, true)
  assert.ok(Math.abs(s.t_stat) >= 2)
})

test('gaps (null abnormal returns) are not counted as measurable', () => {
  const withGaps = [...rows(MIN_NARRATIVE_MENTIONS, 3), ...rows(5, null)]
  const s = windowStats(withGaps, '7d')
  assert.equal(s.measurable, MIN_NARRATIVE_MENTIONS)
})

test('aggregateByNarrative groups by narrative x direction', () => {
  const data = [
    ...rows(MIN_NARRATIVE_MENTIONS, 6, { narrative: 'news_reaction', direction: 'bullish' }),
    ...rows(MIN_NARRATIVE_MENTIONS, -2, { narrative: 'warning', direction: 'bearish' }),
  ]
  const groups = aggregateByNarrative(data)
  assert.equal(groups.length, 2)
  const news = groups.find((g) => g.narrative === 'news_reaction')
  assert.equal(news.direction, 'bullish')
  assert.equal(news.by_window['7d'].avg_abnormal_return, 6)
})

// --- abnormal-return extension on the pricing side ---

test('calculateRawReturn is direction-agnostic', () => {
  assert.equal(calculateRawReturn(100, 110), 10)
  assert.equal(calculateRawReturn(100, 90), -10)
  // Directional flips the sign for bearish; raw never does.
  assert.equal(calculateDirectionalReturn('bearish', 100, 90), 10)
  assert.equal(calculateRawReturn(100, 90), -10)
})

test('_resultForMention emits raw + benchmark + abnormal per window', () => {
  const mention = { id: 1, asset_id: 1, event_time: '2026-01-05T15:00:00.000Z', direction: 'bearish' }
  // Entry at the mention minute (100); asset up 10% over 7d; SPY up 4% →
  // abnormal = +6 (raw, un-flipped).
  const minuteBars = [{ timestamp: '2026-01-05T15:00:00.000Z', open: 100, close: 100 }]
  const dailyBars = [
    { date: '2026-01-05', open: 100, close: 100 },
    { date: '2026-01-12', open: 110, close: 110 },
  ]
  const benchmarkBars = [
    { date: '2026-01-05', close: 400 },
    { date: '2026-01-12', close: 416 },
  ]
  const out = _resultForMention(mention, ['7d'], { minuteBars, dailyBars, benchmarkBars })
  assert.equal(out.raw_return_7d, 10)
  assert.equal(out.return_7d, -10) // directional (bearish call was wrong)
  assert.equal(Math.round(out.benchmark_return_7d), 4)
  assert.equal(Math.round(out.abnormal_return_7d), 6)
})
