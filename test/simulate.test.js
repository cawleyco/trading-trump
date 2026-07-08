import test from 'node:test'
import assert from 'node:assert/strict'
import { findLevelExit } from '../server/backtest/simulate.js'

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
