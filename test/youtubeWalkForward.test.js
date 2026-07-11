import test from 'node:test'
import assert from 'node:assert/strict'
import { assembleFolds } from '../server/backtest/youtubeWalkForward.js'
import { splitWindows } from '../server/backtest/walkForward.js'

// Priced-mention fixture: channel A is consistently good in Jan (train) and
// keeps producing in Feb (test); channel B looks great in Jan but has too few
// mentions to qualify; channel C is bad in Jan.
function row(channelId, day, ret) {
  return {
    mention_id: Math.random(),
    channel_id: channelId,
    channel_title: `Channel ${channelId}`,
    event_time: `${day}T12:00:00Z`,
    return_30d: ret,
    benchmark_return_30d: 1,
  }
}

const priced = [
  // train window (Jan): A qualifies with 2 measurable, avg +6
  row('A', '2026-01-05', 4),
  row('A', '2026-01-20', 8),
  // B: one spectacular mention — below minMentions, must not qualify
  row('B', '2026-01-10', 50),
  // C qualifies but loses
  row('C', '2026-01-08', -5),
  row('C', '2026-01-25', -3),
  // test window (Feb)
  row('A', '2026-02-05', 10),
  row('A', '2026-02-15', -2),
  row('B', '2026-02-10', 40), // not selected — B never qualified in-sample
  row('C', '2026-02-20', -8),
]

test('folds rank creators in-sample and measure only top-N out-of-sample', () => {
  const windows = splitWindows('2026-01-01', '2026-02-28', 2)
  const { foldResults, combined } = assembleFolds(priced, windows, {
    topN: 1,
    minMentions: 2,
    returnKey: 'return_30d',
  })

  assert.equal(foldResults.length, 1)
  const fold = foldResults[0]
  assert.equal(fold.qualifyingCreators, 2, 'A and C qualify; B is below minMentions')
  assert.deepEqual(fold.inSample.map((c) => c.channelId), ['A'])
  assert.equal(fold.inSample[0].avgReturn, 6)

  // Out-of-sample: only A's Feb mentions count (10, -2)
  assert.equal(fold.outOfSample.measurable, 2)
  assert.equal(fold.outOfSample.avgReturn, 4)
  assert.equal(fold.outOfSample.winRate, 0.5)

  assert.equal(combined.measurable, 2)
  assert.equal(combined.avgReturn, 4)
})

test('empty folds are flagged, not silently averaged', () => {
  const windows = splitWindows('2026-01-01', '2026-02-28', 2)
  const { foldResults, combined } = assembleFolds(priced, windows, {
    topN: 1,
    minMentions: 10, // nobody qualifies
    returnKey: 'return_30d',
  })
  assert.equal(foldResults[0].empty, true)
  assert.equal(foldResults[0].outOfSample.measurable, 0)
  assert.equal(combined.avgReturn, null)
})

test('unmeasurable out-of-sample mentions are excluded from rates', () => {
  const windows = splitWindows('2026-01-01', '2026-02-28', 2)
  const withGap = [...priced, { ...row('A', '2026-02-25', null), return_30d: null }]
  const { foldResults } = assembleFolds(withGap, windows, {
    topN: 1,
    minMentions: 2,
    returnKey: 'return_30d',
  })
  assert.equal(foldResults[0].outOfSample.mentions, 3, 'gap mention appears in the count')
  assert.equal(foldResults[0].outOfSample.measurable, 2, 'but not in the rates')
})
