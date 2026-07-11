import test from 'node:test'
import assert from 'node:assert/strict'
import { validateBacktestBody } from '../server/lib/validateBacktestBody.js'

const base = { startDate: '2026-05-20', endDate: '2026-07-08', notionalPerTrade: 1000 }

test('a minimal valid body normalizes with nulls for the optional fields', () => {
  const v = validateBacktestBody(base)
  assert.equal(v.notionalPerTrade, 1000)
  assert.equal(v.exitRule, null)
  assert.equal(v.stopLossPct, null)
  assert.equal(v.holdHours, null)
})

test('numeric strings are coerced, garbage is rejected', () => {
  assert.equal(validateBacktestBody({ ...base, notionalPerTrade: '500' }).notionalPerTrade, 500)
  assert.throws(() => validateBacktestBody({ ...base, notionalPerTrade: 'abc' }), /notionalPerTrade/)
  assert.throws(() => validateBacktestBody({ ...base, notionalPerTrade: 0 }), /notionalPerTrade/)
  assert.throws(() => validateBacktestBody({ ...base, notionalPerTrade: -100 }), /notionalPerTrade/)
  assert.throws(() => validateBacktestBody({ ...base, notionalPerTrade: Infinity }), /notionalPerTrade/)
})

test('dates must be YYYY-MM-DD and ordered', () => {
  assert.throws(() => validateBacktestBody({ ...base, startDate: '05/20/2026' }), /YYYY-MM-DD/)
  assert.throws(() => validateBacktestBody({ ...base, startDate: null }), /YYYY-MM-DD/)
  assert.throws(
    () => validateBacktestBody({ ...base, startDate: '2026-07-09', endDate: '2026-07-01' }),
    /on or before/
  )
})

test('exitRule is whitelisted', () => {
  assert.equal(validateBacktestBody({ ...base, exitRule: 'hold_30' }).exitRule, 'hold_30')
  assert.throws(() => validateBacktestBody({ ...base, exitRule: 'yolo' }), /exitRule/)
})

test('optional numerics reject NaN and enforce bounds', () => {
  assert.throws(() => validateBacktestBody({ ...base, stopLossPct: 'abc' }), /stopLossPct/)
  assert.throws(() => validateBacktestBody({ ...base, holdDays: 1.5 }), /holdDays/)
  assert.throws(() => validateBacktestBody({ ...base, confidenceThreshold: 2 }), /confidenceThreshold/)
  assert.equal(validateBacktestBody({ ...base, confidenceThreshold: 0.8 }).confidenceThreshold, 0.8)
  // empty strings (unfilled form fields) mean "not provided"
  assert.equal(validateBacktestBody({ ...base, stopLossPct: '' }).stopLossPct, null)
})
