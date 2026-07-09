import test from 'node:test'
import assert from 'node:assert/strict'
import { _positionPrices, _exitReason } from '../server/positionManager.js'

test('position prices use current_price when present', () => {
  assert.deepEqual(
    _positionPrices({ avg_entry_price: '100', current_price: '110', qty: '5', market_value: '550' }),
    { entry: 100, current: 110 }
  )
})

test('position prices fall back to market_value / qty', () => {
  assert.deepEqual(
    _positionPrices({ avg_entry_price: '100', qty: '5', market_value: '550' }),
    { entry: 100, current: 110 }
  )
})

test('a zero-qty position never produces an Infinity price', () => {
  // Alpaca can briefly return a just-closed position with qty 0; the old
  // market_value / qty fallback yielded Infinity and tripped take-profit.
  assert.equal(_positionPrices({ avg_entry_price: '100', qty: '0', market_value: '550' }), null)
  assert.equal(_positionPrices({ avg_entry_price: '100', qty: '0', market_value: '0' }), null)
  assert.equal(_positionPrices({ avg_entry_price: '100', qty: 0 }), null)
})

test('malformed or non-positive prices are skipped', () => {
  assert.equal(_positionPrices({ avg_entry_price: 'abc', current_price: '110' }), null)
  assert.equal(_positionPrices({ avg_entry_price: '0', current_price: '110' }), null)
  assert.equal(_positionPrices({ avg_entry_price: '100', current_price: '-5' }), null)
  assert.equal(_positionPrices({}), null)
})

test('stop-loss triggers at and below the threshold', () => {
  const rules = { stopLossPct: 5, takeProfitPct: 10, maxHoldDays: 30 }
  assert.match(_exitReason({ entry: 100, current: 95, ageDays: 1 }, rules), /stop-loss/)
  assert.match(_exitReason({ entry: 100, current: 90, ageDays: 1 }, rules), /stop-loss/)
  assert.equal(_exitReason({ entry: 100, current: 95.01, ageDays: 1 }, rules), null)
})

test('take-profit triggers at and above the threshold', () => {
  const rules = { stopLossPct: 5, takeProfitPct: 10, maxHoldDays: 30 }
  assert.match(_exitReason({ entry: 100, current: 110, ageDays: 1 }, rules), /take-profit/)
  assert.match(_exitReason({ entry: 100, current: 125, ageDays: 1 }, rules), /take-profit/)
  assert.equal(_exitReason({ entry: 100, current: 109.99, ageDays: 1 }, rules), null)
})

test('max-hold triggers only with a known finite age', () => {
  const rules = { maxHoldDays: 30 }
  assert.match(_exitReason({ entry: 100, current: 100, ageDays: 31 }, rules), /max hold/)
  assert.equal(_exitReason({ entry: 100, current: 100, ageDays: 29 }, rules), null)
  // pre-bot positions have unknown age — must not exit
  assert.equal(_exitReason({ entry: 100, current: 100, ageDays: null }, rules), null)
  assert.equal(_exitReason({ entry: 100, current: 100, ageDays: NaN }, rules), null)
})

test('rules default to disabled when unset', () => {
  assert.equal(_exitReason({ entry: 100, current: 1, ageDays: 999 }, {}), null)
  assert.equal(
    _exitReason({ entry: 100, current: 200, ageDays: 999 }, { stopLossPct: null, takeProfitPct: null, maxHoldDays: null }),
    null
  )
})

test('stop-loss wins when multiple rules match', () => {
  // a -20% move with maxHold also breached must report the loss, not the age
  const rules = { stopLossPct: 5, maxHoldDays: 1 }
  assert.match(_exitReason({ entry: 100, current: 80, ageDays: 10 }, rules), /stop-loss/)
})
