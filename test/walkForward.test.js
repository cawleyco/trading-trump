import test from 'node:test'
import assert from 'node:assert/strict'
import { splitWindows } from '../server/backtest/walkForward.js'

test('splitWindows returns contiguous, non-overlapping windows', () => {
  const w = splitWindows('2026-01-01', '2026-01-09', 2)
  assert.equal(w.length, 2)
  assert.deepEqual(w[0], { start: '2026-01-01', end: '2026-01-05' })
  assert.deepEqual(w[1], { start: '2026-01-06', end: '2026-01-09' })
})

test('first window starts at start, last ends exactly at end', () => {
  const w = splitWindows('2025-01-01', '2025-12-31', 4)
  assert.equal(w.length, 4)
  assert.equal(w[0].start, '2025-01-01')
  assert.equal(w[3].end, '2025-12-31')
  // each window starts the day after the previous one ends
  for (let i = 1; i < w.length; i++) {
    const prevEnd = Date.parse(`${w[i - 1].end}T00:00:00Z`)
    const thisStart = Date.parse(`${w[i].start}T00:00:00Z`)
    assert.equal(thisStart - prevEnd, 86400_000, `window ${i} is contiguous`)
  }
})

test('splitWindows supports one-day folds for short ranges', () => {
  const w = splitWindows('2026-01-01', '2026-01-02', 2)
  assert.deepEqual(w, [
    { start: '2026-01-01', end: '2026-01-01' },
    { start: '2026-01-02', end: '2026-01-02' },
  ])
})

test('splitWindows rejects invalid fold requests', () => {
  assert.throws(() => splitWindows('2026-01-01', '2026-01-02', 3), /folds cannot exceed/)
  assert.throws(() => splitWindows('2026-01-02', '2026-01-01', 2), /startDate/)
  assert.throws(() => splitWindows('2026-01-01', '2026-01-02', 1), /folds must/)
})
