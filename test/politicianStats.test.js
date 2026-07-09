import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPoliticianStats } from '../server/intel/politicianStats.js'

const trade = (overrides) => ({
  politician: 'Jane Doe',
  ticker: 'ABC',
  type: 'buy',
  transaction_date: '2025-01-01',
  disclosure_date: '2025-01-05',
  amount_mid: 10000,
  is_option: 0,
  parse_confidence: 1,
  ...overrides,
})

test('buildPoliticianStats computes horizon returns, lag, concentration, and sectors', async () => {
  const prices = new Map([
    ['ABC|2025-01-05', 100],
    ['ABC|2025-01-12', 110],
    ['ABC|2025-02-04', 90],
    ['ABC|2025-04-05', 120],
    ['ABC|2025-07-04', 130],
    ['XYZ|2025-02-05', 50],
    ['XYZ|2025-02-12', 55],
    ['XYZ|2025-03-07', 60],
    ['XYZ|2025-05-06', 40],
    ['XYZ|2025-08-04', 75],
  ])
  const stats = await buildPoliticianStats(
    'Jane Doe',
    [
      trade({ ticker: 'ABC' }),
      trade({ ticker: 'XYZ', transaction_date: '2025-02-01', disclosure_date: '2025-02-05', amount_mid: 30000 }),
      trade({ ticker: 'ABC', type: 'sell', transaction_date: '2025-03-01', disclosure_date: '2025-03-03', amount_mid: 20000 }),
    ],
    {
      asOf: '2026-01-01',
      priceFn: async (ticker, date) => prices.get(`${ticker}|${date}`) ?? null,
      sectorFn: async (ticker) => (ticker === 'ABC' ? 'technology' : 'energy'),
    }
  )

  assert.equal(stats.trade_count, 3)
  assert.equal(stats.buy_count, 2)
  assert.equal(stats.sell_count, 1)
  assert.equal(stats.median_disclosure_lag, 4)
  assert.equal(stats.avg_amount_mid, 20000)
  assert.equal(stats.win_rate_30d, 50)
  assert.equal(stats.win_rate_90d, 50)
  assert.equal(stats.avg_return_7d, 10)
  assert.equal(stats.avg_return_30d, 5)
  assert.equal(stats.avg_return_90d, 0)
  assert.equal(stats.avg_return_180d, 40)
  assert.equal(stats.best_hold_window, '180d')
  assert.equal(stats.concentration_hhi, 0.5556)
  assert.deepEqual(stats.sector_returns, {
    technology: { trades: 1, avgReturn30d: -10 },
    energy: { trades: 1, avgReturn30d: 20 },
  })
})

test('buildPoliticianStats excludes options and low confidence trades', async () => {
  const stats = await buildPoliticianStats(
    'Jane Doe',
    [
      trade({ ticker: 'ABC' }),
      trade({ ticker: 'OPT', is_option: 1 }),
      trade({ ticker: 'LOW', parse_confidence: 0.5 }),
    ],
    {
      asOf: '2026-01-01',
      priceFn: async () => 100,
      sectorFn: async () => 'other',
    }
  )

  assert.equal(stats.trade_count, 1)
  assert.equal(stats.buy_count, 1)
  assert.equal(stats.stats.measured_buys, 1)
})
