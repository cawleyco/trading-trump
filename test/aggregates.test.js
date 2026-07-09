import test from 'node:test'
import assert from 'node:assert/strict'
import { sinceDaysAgo, buildMatrix, conflictRiskIndex } from '../server/intel/aggregates.js'

test('sinceDaysAgo returns an ISO date N days before the reference', () => {
  const now = new Date('2026-07-09T12:00:00Z')
  assert.equal(sinceDaysAgo(0, now), '2026-07-09')
  assert.equal(sinceDaysAgo(9, now), '2026-06-30')
  assert.equal(sinceDaysAgo(30, now), '2026-06-09')
})

test('buildMatrix pivots flat records into sorted rows/cols/cells', () => {
  const m = buildMatrix(
    [
      { sector: 'Tech', week: '2026-01-05', net: 3 },
      { sector: 'Tech', week: '2026-01-12', net: -1 },
      { sector: 'Energy', week: '2026-01-05', net: 2 },
    ],
    { rowKey: 'sector', colKey: 'week' }
  )
  assert.deepEqual(m.rows, ['Energy', 'Tech'])
  assert.deepEqual(m.cols, ['2026-01-05', '2026-01-12'])
  assert.equal(m.cells['Tech']['2026-01-12'].net, -1)
  assert.equal(m.cells['Energy']['2026-01-05'].net, 2)
  assert.equal(m.cells['Energy']['2026-01-12'], undefined)
})

test('buildMatrix skips records missing a row or col key', () => {
  const m = buildMatrix(
    [
      { sector: 'Tech', week: null, net: 1 },
      { sector: null, week: '2026-01-05', net: 1 },
      { sector: 'Tech', week: '2026-01-05', net: 4 },
    ],
    { rowKey: 'sector', colKey: 'week' }
  )
  assert.deepEqual(m.rows, ['Tech'])
  assert.deepEqual(m.cols, ['2026-01-05'])
})

test('conflictRiskIndex blends signals and clamps to 100', () => {
  assert.equal(conflictRiskIndex({}), 0)
  assert.equal(conflictRiskIndex({ tradeCount: 2, politicianCount: 1 }), 19)
  assert.equal(conflictRiskIndex({ lobbyingCount: 1, contractCount: 1 }), 12)
  assert.equal(conflictRiskIndex({ tradeCount: 100 }), 100) // clamped
})
