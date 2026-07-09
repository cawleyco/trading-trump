import test from 'node:test'
import assert from 'node:assert/strict'
import {
  disclosureLagDays,
  publishLagDays,
  ageDays,
  freshnessScore,
} from '../server/intel/freshness.js'

const trade = {
  transaction_date: '2026-06-01',
  disclosure_date: '2026-06-08',
  first_seen_at: '2026-06-09 12:00:00',
}

test('disclosureLagDays counts trade → disclosure', () => {
  assert.equal(disclosureLagDays(trade), 7)
})

test('publishLagDays counts trade → first seen', () => {
  assert.equal(publishLagDays(trade), 8)
})

test('ageDays counts first_seen → now', () => {
  assert.equal(ageDays(trade, '2026-06-19T12:00:00Z'), 10)
})

test('accepts camelCase normalized trades too', () => {
  const camel = { transactionDate: '2026-06-01', disclosureDate: '2026-06-08' }
  assert.equal(disclosureLagDays(camel), 7)
})

test('null-safe when dates are missing', () => {
  assert.equal(disclosureLagDays({}), null)
  assert.equal(publishLagDays({ transaction_date: '2026-06-01' }), null)
  assert.equal(ageDays({}), null)
})

test('freshnessScore is 100 within 5 days of the trade', () => {
  const r = freshnessScore(trade, '2026-06-05T00:00:00Z') // 4 days after txn
  assert.equal(r.score, 100)
  assert.equal(r.lagDays, 4)
  assert.equal(r.basis, 'transaction')
})

test('freshnessScore hits 0 at 60 days and beyond', () => {
  assert.equal(freshnessScore(trade, '2026-07-31T00:00:00Z').score, 0) // 60 days
  assert.equal(freshnessScore(trade, '2026-09-01T00:00:00Z').score, 0) // way past
})

test('freshnessScore interpolates linearly in between', () => {
  // lag 30 days → 100 * (60-30)/55 = 54.5 → 55
  const r = freshnessScore(trade, '2026-07-01T00:00:00Z')
  assert.equal(r.lagDays, 30)
  assert.equal(r.score, 55)
})

test('freshnessScore falls back to disclosure date when transaction is missing', () => {
  const noTxn = { disclosure_date: '2026-06-01', first_seen_at: '2026-06-02' }
  const r = freshnessScore(noTxn, '2026-06-04T00:00:00Z') // 3 days after disclosure
  assert.equal(r.basis, 'disclosure')
  assert.equal(r.score, 100)
})

test('freshnessScore returns null score when no date is usable', () => {
  const r = freshnessScore({ first_seen_at: '2026-06-02' }, '2026-06-10T00:00:00Z')
  assert.equal(r.score, null)
  assert.equal(r.basis, null)
})
