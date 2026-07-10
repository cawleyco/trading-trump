import test from 'node:test'
import assert from 'node:assert/strict'
import { _computeDrift, _computeAdv, _firstCloseOnOrAfter, _barsTtl, _minuteBarsTtl } from '../server/marketData.js'

const bar = (date, close, volume) => ({ date, open: close, close, volume })

test('_computeDrift computes percent change', () => {
  assert.equal(_computeDrift(100, 110), 10)
  assert.equal(_computeDrift(100, 85), -15)
  assert.equal(_computeDrift(50, 50), 0)
})

test('_computeDrift returns null on missing or zero inputs', () => {
  assert.equal(_computeDrift(null, 110), null)
  assert.equal(_computeDrift(100, null), null)
  assert.equal(_computeDrift(0, 110), null)
  assert.equal(_computeDrift(undefined, undefined), null)
})

test('_computeAdv averages close×volume over the last N bars', () => {
  const bars = [
    bar('2026-01-02', 10, 1000), // 10,000 — outside the 2-bar window
    bar('2026-01-03', 20, 1000), // 20,000
    bar('2026-01-04', 30, 2000), // 60,000
  ]
  assert.equal(_computeAdv(bars, 2), 40000)
  assert.equal(_computeAdv(bars, 3), 30000)
})

test('_computeAdv skips bars missing close or volume', () => {
  const bars = [
    bar('2026-01-02', 10, null),
    bar('2026-01-03', null, 500),
    bar('2026-01-04', 30, 2000), // only usable bar → 60,000
  ]
  assert.equal(_computeAdv(bars, 20), 60000)
})

test('_computeAdv returns null when nothing is usable', () => {
  assert.equal(_computeAdv([], 20), null)
  assert.equal(_computeAdv(null, 20), null)
  assert.equal(_computeAdv([bar('2026-01-02', 10, null)], 20), null)
})

test('_firstCloseOnOrAfter picks the first trading day ≥ date', () => {
  const bars = [bar('2026-01-02', 100, 1), bar('2026-01-05', 105, 1), bar('2026-01-06', 110, 1)]
  assert.equal(_firstCloseOnOrAfter(bars, '2026-01-02'), 100)
  assert.equal(_firstCloseOnOrAfter(bars, '2026-01-03'), 105) // weekend → next trading day
  assert.equal(_firstCloseOnOrAfter(bars, '2026-01-07'), null) // past the data
  assert.equal(_firstCloseOnOrAfter(null, '2026-01-02'), null)
})

test('_barsTtl: historical ranges never expire, ranges touching today keep 1h', () => {
  const nowMs = Date.parse('2026-07-10T15:00:00Z')
  assert.equal(_barsTtl('2026-07-09', nowMs), null) // ended before today → immutable
  assert.equal(_barsTtl('2020-01-01', nowMs), null)
  assert.equal(_barsTtl('2026-07-10', nowMs), 3600_000) // ends today → mutable
  assert.equal(_barsTtl('2026-07-11', nowMs), 3600_000)
  assert.equal(_barsTtl('2026-07-09T23:59:00Z', nowMs), null) // ISO timestamps truncate to date
})

test('_minuteBarsTtl: ranges ending >24h ago never expire', () => {
  const nowMs = Date.parse('2026-07-10T15:00:00Z')
  assert.equal(_minuteBarsTtl('2026-07-09T14:00:00Z', nowMs), null)
  assert.equal(_minuteBarsTtl('2026-07-09T16:00:00Z', nowMs), 3600_000) // within 24h
  assert.equal(_minuteBarsTtl('2026-07-10T14:59:00Z', nowMs), 3600_000)
  assert.equal(_minuteBarsTtl('not-a-date', nowMs), 3600_000) // unparseable → safe short TTL
})
