import test from 'node:test'
import assert from 'node:assert/strict'
import { validateRiskLimits, validateAutoExit } from '../server/config.js'

test('sane risk limits pass', () => {
  validateRiskLimits(
    {
      maxTradeNotionalUsd: 100,
      maxTradePctEquity: 2,
      maxOpenPositions: 10,
      maxTotalExposureUsd: 1000,
      maxDailyLossUsd: 50,
      maxDailyLossPct: 2,
    },
    'risk'
  )
})

test('unset limits are treated as disabled, not invalid', () => {
  validateRiskLimits({}, 'risk')
  validateRiskLimits({ maxDailyLossUsd: null }, 'risk')
  validateAutoExit(null, 'autoExit')
  validateAutoExit({ stopLossPct: null }, 'autoExit')
})

test('negative and zero caps are rejected with the field name', () => {
  assert.throws(() => validateRiskLimits({ maxTradeNotionalUsd: -100 }, 'risk'), /maxTradeNotionalUsd/)
  assert.throws(() => validateRiskLimits({ maxDailyLossUsd: 0 }, 'risk'), /maxDailyLossUsd/)
})

test('fractional position counts and >100% percentages are rejected', () => {
  assert.throws(() => validateRiskLimits({ maxOpenPositions: 0.5 }, 'risk'), /maxOpenPositions/)
  assert.throws(() => validateRiskLimits({ maxTradePctEquity: 150 }, 'risk'), /maxTradePctEquity/)
  assert.throws(() => validateRiskLimits({ maxDailyLossPct: 101 }, 'risk'), /maxDailyLossPct/)
})

test('auto-exit rules must be positive; stop-loss cannot exceed 100%', () => {
  validateAutoExit({ stopLossPct: 5, takeProfitPct: 150, maxHoldDays: 30 }, 'autoExit')
  assert.throws(() => validateAutoExit({ stopLossPct: 120 }, 'autoExit'), /stopLossPct/)
  assert.throws(() => validateAutoExit({ takeProfitPct: -10 }, 'autoExit'), /takeProfitPct/)
  assert.throws(() => validateAutoExit({ maxHoldDays: 0 }, 'autoExit'), /maxHoldDays/)
})
