import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeTimeline, findConfluenceWindows } from '../server/intel/confluence.js'
import { evaluateRule } from '../server/intel/alertEngine.js'

const ev = (kind, id, ts, extra = {}) => ({ kind, id, ts, summary: `${kind} ${id}`, ...extra })

test('mergeTimeline sorts newest-first and drops timestampless events', () => {
  const merged = mergeTimeline(
    [ev('congress', 'a', '2026-06-01'), ev('congress', 'b', '2026-06-20')],
    [ev('youtube', 1, '2026-06-10'), { kind: 'youtube', id: 2, ts: null }]
  )
  assert.deepEqual(merged.map((e) => e.id), ['b', 1, 'a'])
})

test('two sources within the window form a confluence; one source never does', () => {
  const events = [
    ev('congress', 'a', '2026-06-01'),
    ev('youtube', 1, '2026-06-08'),
  ]
  const windows = findConfluenceWindows(events, { windowDays: 14, minSources: 2 })
  assert.equal(windows.length, 1)
  assert.deepEqual(windows[0].sources, ['congress', 'youtube'])
  assert.equal(windows[0].start, '2026-06-01')
  assert.equal(windows[0].end, '2026-06-08')

  const single = findConfluenceWindows(
    [ev('congress', 'a', '2026-06-01'), ev('congress', 'b', '2026-06-03')],
    { windowDays: 14, minSources: 2 }
  )
  assert.equal(single.length, 0, 'many events from ONE source is a cluster, not confluence')
})

test('events farther apart than windowDays do not form a window', () => {
  const events = [ev('congress', 'a', '2026-05-01'), ev('trump', 'p1', '2026-06-01')]
  assert.equal(findConfluenceWindows(events, { windowDays: 14, minSources: 2 }).length, 0)
})

test('overlapping windows merge; calendar events never count as a source', () => {
  const events = [
    ev('congress', 'a', '2026-06-01'),
    ev('youtube', 1, '2026-06-06'),
    ev('trump', 'p1', '2026-06-12'),
    ev('calendar', 'c1', '2026-06-07'),
    ev('calendar', 'c2', '2026-06-08'),
  ]
  const windows = findConfluenceWindows(events, { windowDays: 14, minSources: 2 })
  assert.equal(windows.length, 1)
  assert.deepEqual(windows[0].sources, ['congress', 'trump', 'youtube'])
  assert.equal(windows[0].eventCount, 3, 'calendar events excluded')

  const calendarOnly = [ev('calendar', 'c1', '2026-06-01'), ev('calendar', 'c2', '2026-06-02'), ev('youtube', 1, '2026-06-03')]
  assert.equal(findConfluenceWindows(calendarOnly, { windowDays: 14, minSources: 2 }).length, 0)
})

test('minSources 3 requires all three directional sources', () => {
  const twoSources = [ev('congress', 'a', '2026-06-01'), ev('youtube', 1, '2026-06-02')]
  assert.equal(findConfluenceWindows(twoSources, { windowDays: 14, minSources: 3 }).length, 0)
  const threeSources = [...twoSources, ev('trump', 'p1', '2026-06-03')]
  assert.equal(findConfluenceWindows(threeSources, { windowDays: 14, minSources: 3 }).length, 1)
})

test('confluence alert rule fires from both dispatch moments with week-bucketed dedup', () => {
  const rule = { id: 20, rule_type: 'confluence', params: { minSources: 2, windowDays: 14 } }
  const trade = { ticker: 'NVDA', type: 'buy', politician: 'Sen. Y', trade_key: 'k9', disclosure_date: '2026-07-08', transaction_date: '2026-07-01', amount_mid: 100000 }
  const score = { score: 88, recommendation: 'copy-candidate', factors: {}, warnings: [] }

  const fromTrade = evaluateRule(rule, {
    kind: 'trade-scored', trade, score,
    confluenceSources: ['congress', 'youtube'],
  })
  assert.ok(fromTrade)
  assert.match(fromTrade.message, /2 independent sources \(congress, youtube\)/)

  // Same day from the other dispatch moment → identical dedup key, so the
  // second dispatch is a no-op regardless of which source fired first.
  const mention = { id: 3, symbol: 'NVDA', event_time: '2026-07-08T10:00:00Z', mention_quality_score: 80, channel_title: 'Alpha Creator', direction: 'bullish' }
  const fromMention = evaluateRule(rule, {
    kind: 'youtube-mention', mention, alpha: null,
    confluenceSources: ['congress', 'youtube'],
  })
  assert.ok(fromMention)
  assert.equal(fromTrade.dedupKey, fromMention.dedupKey)

  const tooFew = evaluateRule(rule, { kind: 'trade-scored', trade, score, confluenceSources: ['congress'] })
  assert.equal(tooFew, null)
})
