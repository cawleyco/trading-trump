import test from 'node:test'
import assert from 'node:assert/strict'
import { assertStrategyModeAllowed, fundPosture, funds, config } from '../server/config.js'

// These run with TRADING_MODE=dry_run and the default fund (allowAutoStrategies: false).

test('non-auto modes are always allowed', () => {
  for (const mode of ['watch', 'paper', 'manual']) {
    assert.doesNotThrow(() => assertStrategyModeAllowed({ mode, fund: funds[0].name }))
  }
})

test('auto mode is refused when the fund has not opted in', () => {
  assert.throws(
    () => assertStrategyModeAllowed({ mode: 'auto', fund: funds[0].name }),
    /does not permit auto-mode strategies/
  )
})

test('auto mode targeting an unknown fund is refused', () => {
  assert.throws(
    () => assertStrategyModeAllowed({ mode: 'auto', fund: 'no-such-fund' }),
    /unknown fund/
  )
})

test('fundPosture reports opt-in and effective auto flags', () => {
  const p = fundPosture(funds[0])
  assert.equal(p.name, funds[0].name)
  assert.equal(p.tradingMode, config.tradingMode)
  assert.equal(typeof p.allowAutoStrategies, 'boolean')
  // Effective auto requires both opt-in and live mode; dry_run forces it false.
  assert.equal(p.autoStrategiesEffective, p.allowAutoStrategies && config.isLive)
})
