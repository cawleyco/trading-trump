import test from 'node:test'
import assert from 'node:assert/strict'
import { parseAmountRange } from '../server/lib/amountRange.js'

// Every official STOCK Act band
const OFFICIAL_BANDS = [
  ['$1,001 - $15,000', 1001, 15000],
  ['$15,001 - $50,000', 15001, 50000],
  ['$50,001 - $100,000', 50001, 100000],
  ['$100,001 - $250,000', 100001, 250000],
  ['$250,001 - $500,000', 250001, 500000],
  ['$500,001 - $1,000,000', 500001, 1000000],
  ['$1,000,001 - $5,000,000', 1000001, 5000000],
  ['$5,000,001 - $25,000,000', 5000001, 25000000],
  ['$25,000,001 - $50,000,000', 25000001, 50000000],
]

test('parses every official STOCK Act band', () => {
  for (const [band, min, max] of OFFICIAL_BANDS) {
    const r = parseAmountRange(band)
    assert.equal(r.min, min, band)
    assert.equal(r.max, max, band)
    assert.equal(r.mid, (min + max) / 2, band)
  }
})

test('open-ended "Over" bands use mid = min * 1.5', () => {
  const r = parseAmountRange('Over $50,000,000')
  assert.equal(r.min, 50000000)
  assert.equal(r.max, null)
  assert.equal(r.mid, 75000000)

  const spouse = parseAmountRange('Over $1,000,000')
  assert.equal(spouse.min, 1000000)
  assert.equal(spouse.max, null)
  assert.equal(spouse.mid, 1500000)
})

test('"$X +" style open-ended bands', () => {
  const r = parseAmountRange('$1,000,000 +')
  assert.deepEqual(r, { min: 1000000, max: null, mid: 1500000 })
})

test('truncated "$1,001 -" variant is open-ended', () => {
  const r = parseAmountRange('$1,001 -')
  assert.deepEqual(r, { min: 1001, max: null, mid: 1501.5 })
})

test('band without dollar signs or with extra whitespace still parses', () => {
  assert.deepEqual(parseAmountRange('15,001 - 50,000'), { min: 15001, max: 50000, mid: 32500.5 })
  assert.deepEqual(parseAmountRange('  $1,001   -   $15,000  '), { min: 1001, max: 15000, mid: 8000.5 })
})

test('a single exact amount is min = max = mid', () => {
  assert.deepEqual(parseAmountRange('$32,500'), { min: 32500, max: 32500, mid: 32500 })
})

test('garbage input returns all nulls', () => {
  for (const bad of [null, undefined, '', '   ', 'N/A', '--', 'Unknown', 'no amount listed', {}, 42]) {
    assert.deepEqual(parseAmountRange(bad), { min: null, max: null, mid: null }, String(bad))
  }
})

test('inverted ranges are rejected as garbage', () => {
  assert.deepEqual(parseAmountRange('$50,000 - $15,001'), { min: null, max: null, mid: null })
})
