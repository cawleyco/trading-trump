import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPlans } from '../server/backtest/congressBacktest.js'

// Look-ahead-bias guarantees: a copier following disclosures can only act on
// information at/after its disclosure date. These tests pin that contract.

const WINDOW = { startDate: '2025-01-01', endDate: '2025-12-31' }

const buy = (over = {}) => ({
  politician: 'Rep. Test',
  ticker: 'AAPL',
  type: 'buy',
  transactionDate: '2025-02-01',
  disclosureDate: '2025-03-10',
  amountRange: '$1,001 - $15,000',
  ...over,
})

test('disclosure basis enters at the disclosure date, never the transaction date', () => {
  const plans = buildPlans([buy()], { ...WINDOW, exitRule: 'hold_30', entryBasis: 'disclosure' })
  assert.equal(plans.length, 1)
  assert.equal(plans[0].entryDate, '2025-03-10')
  assert.notEqual(plans[0].entryDate, '2025-02-01')
})

test('follow exit uses the sale disclosure date — the copier cannot see the sale earlier', () => {
  const sale = buy({
    type: 'sell',
    transactionDate: '2025-03-20', // sold before it was public
    disclosureDate: '2025-04-25', // copier learns here
  })
  const plans = buildPlans([buy(), sale], { ...WINDOW, exitRule: 'follow', entryBasis: 'disclosure' })
  assert.equal(plans[0].exitDate, '2025-04-25')
})

test('sales disclosed at or before the buy disclosure never become exits', () => {
  const earlierSale = buy({ type: 'sell', disclosureDate: '2025-03-01' })
  const sameDaySale = buy({ type: 'sell', disclosureDate: '2025-03-10' })
  const plans = buildPlans([buy(), earlierSale, sameDaySale], {
    ...WINDOW,
    exitRule: 'follow',
    entryBasis: 'disclosure',
  })
  assert.equal(plans[0].exitDate, null, 'stale sales must not close the copied position')
})

test('the trade window always filters on disclosure date, even in fantasy mode', () => {
  // transaction happened inside the window but disclosure landed after it —
  // a live copier never saw this trade, so no basis may include it
  const lateDisclosure = buy({ transactionDate: '2025-12-15', disclosureDate: '2026-01-20' })
  for (const entryBasis of ['transaction', 'disclosure', 'first_seen']) {
    const plans = buildPlans([lateDisclosure], { ...WINDOW, exitRule: 'hold_30', entryBasis })
    assert.equal(plans.length, 0, `${entryBasis} basis leaked an undisclosed trade into the window`)
  }
})

test('transaction (fantasy) basis is labeled by its data and drops undated trades', () => {
  const undated = buy({ transactionDate: null })
  const plans = buildPlans([buy(), undated], { ...WINDOW, exitRule: 'hold_30', entryBasis: 'transaction' })
  assert.equal(plans.length, 1)
  assert.equal(plans[0].entryDate, '2025-02-01')
})

test('first_seen basis falls back to disclosure date for backfilled rows', () => {
  const backfilled = buy({ firstSeenAt: null })
  const live = buy({ ticker: 'MSFT', firstSeenAt: '2025-03-12 14:00:00' })
  const plans = buildPlans([backfilled, live], { ...WINDOW, exitRule: 'hold_30', entryBasis: 'first_seen' })
  assert.equal(plans.find((p) => p.ticker === 'AAPL').entryDate, '2025-03-10')
  assert.equal(plans.find((p) => p.ticker === 'MSFT').entryDate, '2025-03-12')
})
