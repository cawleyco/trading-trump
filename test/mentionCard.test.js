import test from 'node:test'
import assert from 'node:assert/strict'
import { buildMentionCard, mentionAlertMessage, mentionSuggestedAction } from '../server/influence/mentionCard.js'

const NOW = new Date('2026-07-11T12:00:00Z').getTime()

const mention = {
  id: 5,
  symbol: 'NVDA',
  channel_title: 'Alpha Creator',
  video_title: 'Why I am buying',
  direction: 'bullish',
  mention_type: 'direct_recommendation',
  mention_quality_score: 84,
  conviction_score: 90,
  pump_risk_score: 12,
  entity_confidence: 0.95,
  event_time: '2026-07-10T09:00:00Z',
  summary: 'Creator announced a new long position.',
}

const followAlpha = {
  label: 'follow',
  alpha_score: 78,
  measurable_mentions: 14,
  avg_return_30d: 5.1,
  win_rate_30d: 0.64,
  pump_dump_rate: 0.07,
  alpha_basis: 'avg_return_30d percentile over 14 measurable mentions',
}

test('card states what happened and why it matters for a proven creator', () => {
  const card = buildMentionCard(mention, followAlpha, { now: () => NOW })
  assert.match(card.what, /Alpha Creator mentioned NVDA \(bullish, direct recommendation\)/)
  assert.match(card.what, /"Why I am buying" on 2026-07-10/)
  assert.match(card.whyItMatters[0], /Proven-alpha creator: 78th percentile over 14 measurable mentions/)
  assert.equal(card.suggestedAction, 'copy_candidate')
  assert.equal(card.creatorLabel, 'follow')
  // fresh, high-confidence, low-pump mention from a proven creator → no risk noise
  assert.deepEqual(card.risks, [])
})

test('unproven creators always carry a no-edge risk line', () => {
  const card = buildMentionCard(mention, null, { now: () => NOW })
  assert.ok(card.risks.some((r) => /track record unproven/.test(r)))
  assert.equal(card.suggestedAction, 'watch', 'quality alone rates a watch, never a copy')
})

test('risks accumulate: pump, stale age, weak entity match, sponsorship', () => {
  const risky = {
    ...mention,
    pump_risk_score: 75,
    entity_confidence: 0.6,
    mention_type: 'sponsored_promotion',
    event_time: '2026-06-30T09:00:00Z',
  }
  const card = buildMentionCard(risky, null, { now: () => NOW })
  assert.ok(card.risks.some((r) => /Pump risk 75\/100/.test(r)))
  assert.ok(card.risks.some((r) => /11 days old/.test(r)))
  assert.ok(card.risks.some((r) => /confidence 0\.60/.test(r)))
  assert.ok(card.risks.some((r) => /sponsored promotion/.test(r)))
  assert.equal(card.suggestedAction, 'avoid')
})

test('fade-labeled creators produce a contrarian framing, not a buy signal', () => {
  const fadeAlpha = { ...followAlpha, label: 'fade', avg_return_30d: -4, pump_dump_rate: 0.45 }
  const card = buildMentionCard(mention, fadeAlpha, { now: () => NOW })
  assert.ok(card.whyItMatters.some((w) => /contrarian read, not a buy signal/.test(w)))
  assert.equal(card.suggestedAction, 'fade-candidate')
  assert.equal(mentionSuggestedAction(mention, fadeAlpha), 'fade-candidate')
})

test('alert message is a single line with quality, what, and action', () => {
  const msg = mentionAlertMessage(mention, followAlpha)
  assert.match(msg, /^\[q84\/100\]/)
  assert.match(msg, /Action: copy_candidate\.$/)
  assert.doesNotMatch(msg, /\n/)
})
