import test from 'node:test'
import assert from 'node:assert/strict'
import { median, pctWithin } from '../server/intel/freshnessReports.js'

test('median handles odd and even lengths', () => {
  assert.equal(median([5]), 5)
  assert.equal(median([3, 1, 2]), 2)
  assert.equal(median([4, 1, 3, 2]), 2.5)
  assert.equal(median([10, 30, 20]), 20) // unsorted input
})

test('pctWithin computes the share ≤ limit', () => {
  assert.equal(pctWithin([10, 20, 30, 40], 25), 50)
  assert.equal(pctWithin([5, 10, 15], 15), 100)
  assert.equal(pctWithin([50, 60], 45), 0)
  assert.equal(pctWithin([], 30), 0)
})

test('pctWithin rounds to one decimal', () => {
  // 1 of 3 within limit → 33.3
  assert.equal(pctWithin([10, 50, 60], 15), 33.3)
})
