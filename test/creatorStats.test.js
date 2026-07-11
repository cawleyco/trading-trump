import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MIN_ALPHA_MENTIONS,
  PUMP_FADE_THRESHOLD,
  FOLLOW_MIN_PERCENTILE,
  rawCreatorMetrics,
  percentileAlphaScores,
  labelCreator,
} from '../server/influence/creatorStats.js'

function results({ measurable = 0, gaps = 0, ret = 5, pumpPairs = 0, pumpy = 0 } = {}) {
  const rows = []
  for (let i = 0; i < measurable; i++) rows.push({ return_30d: ret })
  for (let i = 0; i < gaps; i++) rows.push({ return_30d: null })
  for (let i = 0; i < pumpPairs; i++) {
    rows.push({ return_24h: i < pumpy ? 10 : 1, return_7d: i < pumpy ? -10 : 1 })
  }
  return rows
}

test('rawCreatorMetrics counts only priced mentions as measurable', () => {
  const m = rawCreatorMetrics(results({ measurable: 3, gaps: 7, ret: 4 }))
  assert.equal(m.sample_size, 10)
  assert.equal(m.measurable_mentions, 3)
  assert.equal(m.avg_return_30d, 4)
  assert.equal(m.win_rate_30d, 1)
})

test('percentile scores exclude creators below the minimum sample', () => {
  const scores = percentileAlphaScores([
    { channelId: 1, measurable: MIN_ALPHA_MENTIONS, avgReturn30d: -2 },
    { channelId: 2, measurable: MIN_ALPHA_MENTIONS + 5, avgReturn30d: 3 },
    { channelId: 3, measurable: MIN_ALPHA_MENTIONS, avgReturn30d: 8 },
    { channelId: 4, measurable: MIN_ALPHA_MENTIONS - 1, avgReturn30d: 99 }, // huge return, tiny sample
  ])
  assert.equal(scores.has(4), false, 'sub-minimum creator gets no score, however good it looks')
  assert.equal(scores.get(1), 0)
  assert.equal(scores.get(2), 50)
  assert.equal(scores.get(3), 100)
})

test('below the minimum sample, alpha is null and label is insufficient_data', () => {
  const out = labelCreator({ measurable: MIN_ALPHA_MENTIONS - 1, avgReturn30d: 50, alphaScore: 100, pumpDumpRate: 0, pdMeasurable: 0 })
  assert.equal(out.label, 'insufficient_data')
  assert.equal(out.alpha_score, null)
  assert.equal(out.fade_score, null)
  assert.match(out.alpha_basis, /requires 10 measurable/)
})

test('negative average return labels a qualifying creator fade', () => {
  const out = labelCreator({ measurable: MIN_ALPHA_MENTIONS, avgReturn30d: -1.5, alphaScore: 20, pumpDumpRate: 0, pdMeasurable: MIN_ALPHA_MENTIONS })
  assert.equal(out.label, 'fade')
  assert.equal(out.fade_score, 80)
})

test('pump-dump rate alone can label fade, but only with enough measurable pairs', () => {
  const pumpyEnough = labelCreator({
    measurable: MIN_ALPHA_MENTIONS,
    avgReturn30d: 2,
    alphaScore: 70,
    pumpDumpRate: PUMP_FADE_THRESHOLD,
    pdMeasurable: MIN_ALPHA_MENTIONS,
  })
  assert.equal(pumpyEnough.label, 'fade')

  const pumpyThin = labelCreator({
    measurable: MIN_ALPHA_MENTIONS,
    avgReturn30d: 2,
    alphaScore: 70,
    pumpDumpRate: 0.9,
    pdMeasurable: MIN_ALPHA_MENTIONS - 1, // fading needs the same statistical bar
  })
  assert.notEqual(pumpyThin.label, 'fade')
})

test('follow requires high percentile AND positive returns', () => {
  const follow = labelCreator({ measurable: 20, avgReturn30d: 4, alphaScore: FOLLOW_MIN_PERCENTILE, pumpDumpRate: 0.05, pdMeasurable: 20 })
  assert.equal(follow.label, 'follow')

  // Best of a losing cohort is not edge.
  const bestLoser = labelCreator({ measurable: 20, avgReturn30d: 0, alphaScore: 100, pumpDumpRate: 0.05, pdMeasurable: 20 })
  assert.notEqual(bestLoser.label, 'follow')

  const midPack = labelCreator({ measurable: 20, avgReturn30d: 4, alphaScore: FOLLOW_MIN_PERCENTILE - 1, pumpDumpRate: 0.05, pdMeasurable: 20 })
  assert.equal(midPack.label, 'neutral')
})
