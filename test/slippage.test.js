import test from 'node:test'
import assert from 'node:assert/strict'
import { applyCosts, slippageTierBps } from '../server/backtest/simulate.js'
import { _computeAdv } from '../server/marketData.js'

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`)

test('applyCosts with no costs matches the raw price move (long)', () => {
  const r = applyCosts(100, 110, 1, 1000, 0, 0)
  near(r.entryPrice, 100)
  near(r.exitPrice, 110)
  near(r.qty, 10)
  near(r.pnl, 100)
  near(r.returnPct, 10)
})

test('applyCosts with no costs works for shorts (profit when price falls)', () => {
  const r = applyCosts(100, 90, -1, 1000, 0, 0)
  near(r.pnl, 100)
  near(r.returnPct, 10)
})

test('slippage worsens both fills on a long', () => {
  const r = applyCosts(100, 110, 1, 1000, 100, 0) // 100 bps = 1%
  near(r.entryPrice, 101) // pay more
  near(r.exitPrice, 108.9) // receive less
  assert.ok(r.pnl < 100, 'slippage reduces P&L')
  near(r.pnl, (108.9 - 101) * (1000 / 101))
})

test('slippage worsens a short too', () => {
  const raw = applyCosts(100, 90, -1, 1000, 0, 0)
  const slipped = applyCosts(100, 90, -1, 1000, 100, 0)
  assert.ok(slipped.pnl < raw.pnl, 'slippage reduces short P&L')
})

test('fee is subtracted from round-trip P&L', () => {
  const r = applyCosts(100, 110, 1, 1000, 0, 5)
  near(r.pnl, 95)
  near(r.returnPct, 9.5)
})

test('slippage and fee stack', () => {
  const r = applyCosts(100, 110, 1, 1000, 100, 5)
  near(r.pnl, (108.9 - 101) * (1000 / 101) - 5)
})

test('slippageTierBps buckets by average dollar volume', () => {
  assert.equal(slippageTierBps(60e6), 5)
  assert.equal(slippageTierBps(50e6), 5) // boundary inclusive
  assert.equal(slippageTierBps(20e6), 15)
  assert.equal(slippageTierBps(10e6), 15)
  assert.equal(slippageTierBps(5e6), 40)
  assert.equal(slippageTierBps(1e6), 40)
  assert.equal(slippageTierBps(500e3), 100)
  assert.equal(slippageTierBps(null), null)
})

test('auto-slippage tier derived from fixture bars', () => {
  // ADV = mean(close×volume). 3 bars all at $100 × 1,000,000 shares = $100M → 5 bps
  const bars = [
    { date: '2026-01-02', close: 100, volume: 1_000_000 },
    { date: '2026-01-03', close: 100, volume: 1_000_000 },
    { date: '2026-01-04', close: 100, volume: 1_000_000 },
  ]
  assert.equal(slippageTierBps(_computeAdv(bars, 20)), 5)

  // Thin name: $100 × 5,000 = $500k → 100 bps
  const thin = [{ date: '2026-01-02', close: 100, volume: 5_000 }]
  assert.equal(slippageTierBps(_computeAdv(thin, 20)), 100)
})
