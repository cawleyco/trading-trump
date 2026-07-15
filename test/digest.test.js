import test from 'node:test'
import assert from 'node:assert/strict'
import { buildMorningDigest } from '../server/digest.js'

const DATE = '2026-07-12'

test('a quiet night produces no sections and a calm plain-text line', () => {
  const digest = buildMorningDigest({ date: DATE, mentions: [], trades: [], confluences: [], pumpWarnings: [] })
  assert.equal(digest.sections.length, 0)
  assert.match(digest.plain, /Quiet night/)
  assert.equal(digest.title, `Morning brief — ${DATE}`)
})

test('sections are elided individually, not padded', () => {
  const digest = buildMorningDigest({
    date: DATE,
    mentions: [],
    trades: [{ ticker: 'LMT', type: 'buy', politician: 'Sen. Y', disclosure_date: '2026-07-11', score: 88, recommendation: 'copy-candidate' }],
    confluences: [],
    pumpWarnings: [],
  })
  assert.deepEqual(digest.sections.map((s) => s.key), ['trades'])
  assert.match(digest.plain, /LMT buy — Sen\. Y \[88\/100 copy-candidate\]/)
  assert.doesNotMatch(digest.plain, /mention|confluence|Pump/i)
})

test('follow-creator mentions are starred and listed first; labels annotated', () => {
  const digest = buildMorningDigest({
    date: DATE,
    mentions: [
      { symbol: 'PLTR', direction: 'bullish', channel_title: 'Noisy Channel', creator_label: 'insufficient_data', mention_quality_score: 90 },
      { symbol: 'NVDA', direction: 'bullish', channel_title: 'Alpha Creator', creator_label: 'follow', creator_alpha: 78, mention_quality_score: 84 },
      { symbol: 'DOGE', direction: 'bullish', channel_title: 'Pump Palace', creator_label: 'fade', mention_quality_score: 60 },
    ],
    trades: [],
    confluences: [],
    pumpWarnings: [],
  })
  const items = digest.sections[0].items
  assert.match(items[0], /^★ NVDA bullish — Alpha Creator \(FOLLOW, alpha 78\)/)
  assert.ok(items.some((i) => /Noisy Channel \(unproven creator\)/.test(i)))
  assert.ok(items.some((i) => /Pump Palace \(FADE — contrarian read\)/.test(i)))
})

test('repeat mentions of one ticker by one creator collapse to a single counted line', () => {
  const btc = { symbol: 'BTC', direction: 'bullish', channel_title: 'Altcoin Daily', creator_label: 'insufficient_data', mention_quality_score: 40 }
  const digest = buildMorningDigest({
    date: DATE,
    mentions: [btc, btc, btc, { ...btc, mention_quality_score: 70 }],
    trades: [],
    confluences: [],
    pumpWarnings: [],
  })
  const items = digest.sections[0].items
  assert.equal(items.length, 1)
  assert.match(items[0], /^BTC bullish ×4 — Altcoin Daily \(unproven creator\)$/)
  assert.match(digest.sections[0].title, /\(4\)/, 'header keeps the raw mention count')
})

test('confluence and pump sections render with source lists and held emphasis', () => {
  const digest = buildMorningDigest({
    date: DATE,
    mentions: [],
    trades: [],
    confluences: [{ ticker: 'AAPL', sources: ['congress', 'trump', 'youtube'], windowDays: 14 }],
    pumpWarnings: [{ symbol: 'GME', pump_risk_score: 85, channel_title: 'Pump Palace' }],
  })
  assert.deepEqual(digest.sections.map((s) => s.key), ['confluence', 'pump'])
  assert.match(digest.plain, /AAPL: congress \+ trump \+ youtube all active within 14 days/)
  assert.match(digest.plain, /HELD positions/)
  assert.match(digest.plain, /GME — pump risk 85\/100 from Pump Palace/)
})
