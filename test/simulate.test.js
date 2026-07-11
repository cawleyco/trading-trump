import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyCosts,
  findLevelExit,
  simulateTrades,
  SKIP_FETCH_FAILED,
  SKIP_NO_DATA,
  SKIP_NO_ENTRY_PRICE,
} from '../server/backtest/simulate.js'

// bars: entry at index 0 open=100; SL/TP walking starts at index 1
const mkBar = (date, open, high, low, close) => ({ date, open, high, low, close })

test('long stop-loss fills at the stop price when crossed intrabar', () => {
  const bars = [
    mkBar('2026-01-02', 100, 101, 99, 100),
    mkBar('2026-01-03', 98, 99, 91, 95), // low 91 crosses 92 stop
  ]
  const exit = findLevelExit(bars, 0, 100, 1, 8, null) // stop at 92
  assert.equal(exit.exitReason, 'stop-loss')
  assert.equal(exit.price, 92)
  assert.equal(exit.bar.date, '2026-01-03')
})

test('long stop-loss fills at the open when the bar gaps below the stop', () => {
  const bars = [
    mkBar('2026-01-02', 100, 101, 99, 100),
    mkBar('2026-01-03', 85, 88, 84, 86), // opens below 92 stop
  ]
  const exit = findLevelExit(bars, 0, 100, 1, 8, null)
  assert.equal(exit.exitReason, 'stop-loss')
  assert.equal(exit.price, 85) // honest gap fill, not the stop level
})

test('long take-profit fills at the target when crossed intrabar', () => {
  const bars = [
    mkBar('2026-01-02', 100, 101, 99, 100),
    mkBar('2026-01-03', 102, 112, 101, 108), // high 112 crosses 110 target
  ]
  const exit = findLevelExit(bars, 0, 100, 1, null, 10)
  assert.equal(exit.exitReason, 'take-profit')
  assert.ok(Math.abs(exit.price - 110) < 1e-9)
})

test('stop wins when both levels are hit inside one bar (conservative)', () => {
  const bars = [
    mkBar('2026-01-02', 100, 101, 99, 100),
    mkBar('2026-01-03', 100, 115, 90, 100), // crosses both 92 and 110
  ]
  const exit = findLevelExit(bars, 0, 100, 1, 8, 10)
  assert.equal(exit.exitReason, 'stop-loss')
})

test('returns null when no level is ever hit', () => {
  const bars = [
    mkBar('2026-01-02', 100, 101, 99, 100),
    mkBar('2026-01-03', 100, 103, 98, 101),
    mkBar('2026-01-04', 101, 104, 99, 102),
  ]
  assert.equal(findLevelExit(bars, 0, 100, 1, 8, 10), null)
})

test('short direction mirrors the levels', () => {
  // short entered at 100: stop is price RISING to 108, target is falling to 90
  const bars = [
    mkBar('2026-01-02', 100, 101, 99, 100),
    mkBar('2026-01-03', 101, 109, 100, 105), // high 109 crosses the 108 stop
  ]
  const exit = findLevelExit(bars, 0, 100, -1, 8, 10)
  assert.equal(exit.exitReason, 'stop-loss')
  assert.ok(Math.abs(exit.price - 108) < 1e-9)
})

// ---- simulateTrades with injected providers (fetch failure vs no data) ----

const goodBars = [
  mkBar('2026-01-02', 100, 101, 99, 100),
  mkBar('2026-01-05', 102, 103, 101, 102),
  mkBar('2026-01-06', 103, 104, 102, 104),
]
const plan = { ticker: 'T', direction: 'buy', entryDate: '2026-01-02', holdDays: 2 }

test('provider failure becomes a fetch-failure skip and is never cached across runs', async () => {
  let calls = 0
  const getBars = async () => { calls += 1; return null }
  const r1 = await simulateTrades([plan], 1000, { getBars, benchmark: false })
  assert.equal(r1.trades[0].skipped, true)
  assert.equal(r1.trades[0].skipReason, SKIP_FETCH_FAILED)
  assert.equal(r1.summary.fetchFailures, 1)
  const callsAfterFirstRun = calls
  const r2 = await simulateTrades([plan], 1000, { getBars, benchmark: false })
  assert.ok(calls > callsAfterFirstRun, 'second run must re-invoke the provider')
  assert.equal(r2.summary.fetchFailures, 1)
})

test('empty bars mean "no data for range", distinct from a provider failure', async () => {
  const r = await simulateTrades([plan], 1000, { getBars: async () => [], benchmark: false })
  assert.equal(r.trades[0].skipReason, SKIP_NO_DATA)
  assert.equal(r.summary.fetchFailures, 0)
})

test('one failing ticker does not poison another in the same run', async () => {
  const getBars = async (ticker) => (ticker === 'BAD' ? null : goodBars)
  const r = await simulateTrades(
    [plan, { ...plan, ticker: 'BAD' }],
    1000,
    { getBars, benchmark: false }
  )
  assert.equal(r.summary.totalTrades, 1)
  assert.equal(r.summary.skipped, 1)
  assert.equal(r.summary.fetchFailures, 1)
  assert.ok(Number.isFinite(r.summary.totalPnl))
})

test('identical fetches are deduped within a single run', async () => {
  let calls = 0
  const getBars = async () => { calls += 1; return goodBars }
  await simulateTrades([plan, { ...plan }], 1000, { getBars, benchmark: false })
  assert.equal(calls, 1)
})

test('an entry bar without open or close is skipped, never NaN', async () => {
  const bars = [
    { date: '2026-01-02', open: null, high: null, low: null, close: null },
    mkBar('2026-01-05', 102, 103, 101, 102),
  ]
  const r = await simulateTrades([plan], 1000, { getBars: async () => bars, benchmark: false })
  assert.equal(r.trades[0].skipReason, SKIP_NO_ENTRY_PRICE)
  assert.ok(Number.isFinite(r.summary.totalPnl))
  assert.ok(Number.isFinite(r.summary.returnPct))
})

test('applyCosts rejects zero, negative, and non-finite inputs', () => {
  assert.throws(() => applyCosts(0, 100, 1, 1000))
  assert.throws(() => applyCosts(NaN, 100, 1, 1000))
  assert.throws(() => applyCosts(100, NaN, 1, 1000))
  assert.throws(() => applyCosts(100, 102, 1, NaN))
  assert.throws(() => applyCosts(100, 102, 1, -5))
})
