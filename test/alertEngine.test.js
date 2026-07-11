import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateRule, tradeAlertMessage } from '../server/intel/alertEngine.js'

const trade = {
  trade_key: 'k1',
  politician: 'Sen. Y',
  ticker: 'LMT',
  type: 'buy',
  transaction_date: '2026-06-01',
  disclosure_date: '2026-06-07',
  amount_min: 100000,
  amount_max: 250000,
  amount_mid: 175000,
}

const score = {
  score: 92,
  recommendation: 'copy-candidate',
  factors: { committeeRelevance: { hasData: true, score: 80, detail: 'On Armed Services.' } },
  warnings: [],
}

test('tradeAlertMessage states score, subject, and recommendation on one line', () => {
  const msg = tradeAlertMessage(trade, score)
  assert.match(msg, /^\[92\/100\]/)
  assert.match(msg, /Sen\. Y purchased LMT/)
  assert.match(msg, /Recommendation: copy-candidate\./)
  assert.doesNotMatch(msg, /\n/)
})

test('high-score-trade fires only at or above minScore', () => {
  const rule = { id: 1, rule_type: 'high-score-trade', params: { minScore: 90 } }
  const hit = evaluateRule(rule, { kind: 'trade-scored', trade, score })
  assert.ok(hit)
  assert.equal(hit.dedupKey, 'hs:1:k1')
  const miss = evaluateRule(rule, { kind: 'trade-scored', trade, score: { ...score, score: 80 } })
  assert.equal(miss, null)
})

test('committee-relevant respects minRelevance and hasData', () => {
  const rule = { id: 2, rule_type: 'committee-relevant', params: { minRelevance: 75 } }
  assert.ok(evaluateRule(rule, { kind: 'trade-scored', trade, score }))
  const noData = { ...score, factors: { committeeRelevance: { hasData: false, score: 90 } } }
  assert.equal(evaluateRule(rule, { kind: 'trade-scored', trade, score: noData }), null)
})

test('stale-warning fires on staleness warnings only', () => {
  const rule = { id: 3, rule_type: 'stale-warning', params: {} }
  const stale = { ...score, warnings: [{ code: 'stale-disclosure', message: 'Disclosed 55 days late' }] }
  assert.ok(evaluateRule(rule, { kind: 'trade-scored', trade, score: stale }))
  assert.equal(evaluateRule(rule, { kind: 'trade-scored', trade, score }), null)
})

test('cluster fires at or above clusterCount', () => {
  const rule = { id: 4, rule_type: 'cluster', params: { clusterCount: 3, windowDays: 14 } }
  assert.ok(evaluateRule(rule, { kind: 'trade-scored', trade, score, clusterCount: 4 }))
  assert.equal(evaluateRule(rule, { kind: 'trade-scored', trade, score, clusterCount: 2 }), null)
})

test('watchlist-activity fires on a match for trades and events', () => {
  const rule = { id: 5, rule_type: 'watchlist-activity', params: {} }
  const tradeHit = evaluateRule(rule, { kind: 'trade-scored', trade, score, watchMatches: [{ kind: 'ticker', value: 'LMT' }] })
  assert.equal(tradeHit.dedupKey, 'wl:5:k1')
  const evHit = evaluateRule(rule, {
    kind: 'calendar-event',
    calendarEvent: { id: 9, event_date: '2026-07-01', title: 'Armed Services hearing' },
    watchMatches: [{ kind: 'committee', value: 'SSAS' }],
  })
  assert.equal(evHit.dedupKey, 'wle:5:9')
  assert.equal(evaluateRule(rule, { kind: 'trade-scored', trade, score, watchMatches: [] }), null)
})

test('strategy-match and tweet-catalyst dedup keys and gating', () => {
  const sm = evaluateRule(
    { id: 6, rule_type: 'strategy-match', params: {} },
    { kind: 'strategy-match', strategy: { id: 3, name: 'Defense follow' }, trade, score }
  )
  assert.equal(sm.dedupKey, 'sm:6:3:k1')

  const rule = { id: 7, rule_type: 'tweet-catalyst', params: {} }
  const hit = evaluateRule(rule, { kind: 'post-classified', post: { id: 'p1', text: 'buy tariffs' }, classification: { marketRelevance: 'high', tickers: [{ ticker: 'X' }] } })
  assert.equal(hit.dedupKey, 'tc:7:p1')
  const miss = evaluateRule(rule, { kind: 'post-classified', post: { id: 'p2', text: 'hi' }, classification: { marketRelevance: 'low' } })
  assert.equal(miss, null)
})

test('rules do not fire for the wrong trigger kind', () => {
  const rule = { id: 8, rule_type: 'high-score-trade', params: { minScore: 10 } }
  assert.equal(evaluateRule(rule, { kind: 'strategy-match', strategy: { id: 1, name: 'x' }, trade, score }), null)
})

// --- youtube-mention rules (WS3) ------------------------------------------

const mention = {
  id: 42,
  symbol: 'TSLA',
  channel_id: 7,
  channel_title: 'Alpha Creator',
  video_title: 'My top pick',
  direction: 'bullish',
  mention_type: 'direct_recommendation',
  mention_quality_score: 82,
  pump_risk_score: 10,
  entity_confidence: 0.95,
  event_time: new Date().toISOString(),
}

const followAlpha = {
  label: 'follow',
  alpha_score: 80,
  measurable_mentions: 15,
  avg_return_30d: 4.2,
  win_rate_30d: 0.6,
  pump_dump_rate: 0.05,
}

test('creator-alpha-mention fires for follow creators and never on null alpha', () => {
  const rule = { id: 10, rule_type: 'creator-alpha-mention', params: { minAlpha: 65, minQuality: 70 } }
  const hit = evaluateRule(rule, { kind: 'youtube-mention', mention, alpha: followAlpha })
  assert.ok(hit)
  assert.equal(hit.dedupKey, 'cam:10:42')
  assert.match(hit.message, /Proven-alpha creator/)

  // Trust layer at the alert boundary: null alpha (insufficient sample) never fires.
  const nullAlpha = { ...followAlpha, label: 'follow', alpha_score: null }
  assert.equal(evaluateRule(rule, { kind: 'youtube-mention', mention, alpha: nullAlpha }), null)
  const neutral = { ...followAlpha, label: 'neutral' }
  assert.equal(evaluateRule(rule, { kind: 'youtube-mention', mention, alpha: neutral }), null)
  const lowQuality = { ...mention, mention_quality_score: 50 }
  assert.equal(evaluateRule(rule, { kind: 'youtube-mention', mention: lowQuality, alpha: followAlpha }), null)
})

test('pump-warning fires only for held or watched tickers', () => {
  const rule = { id: 11, rule_type: 'pump-warning', params: { minPumpRisk: 70 } }
  const pumpy = { ...mention, pump_risk_score: 85 }

  const held = evaluateRule(rule, {
    kind: 'youtube-mention', mention: pumpy, alpha: null,
    heldTickers: new Set(['TSLA']), watchMatches: [],
  })
  assert.ok(held)
  assert.match(held.title, /HELD/)

  const watched = evaluateRule(rule, {
    kind: 'youtube-mention', mention: pumpy, alpha: null,
    heldTickers: new Set(), watchMatches: [{ kind: 'ticker', value: 'TSLA' }],
  })
  assert.ok(watched)
  assert.doesNotMatch(watched.title, /HELD/)

  const unrelated = evaluateRule(rule, {
    kind: 'youtube-mention', mention: pumpy, alpha: null,
    heldTickers: new Set(['AAPL']), watchMatches: [],
  })
  assert.equal(unrelated, null)

  const lowPump = evaluateRule(rule, {
    kind: 'youtube-mention', mention, alpha: null,
    heldTickers: new Set(['TSLA']), watchMatches: [],
  })
  assert.equal(lowPump, null)
})

test('fade-candidate-mention requires a fade label and a held/watched ticker', () => {
  const rule = { id: 12, rule_type: 'fade-candidate-mention', params: {} }
  const fadeAlpha = { ...followAlpha, label: 'fade', avg_return_30d: -3, pump_dump_rate: 0.4 }

  const hit = evaluateRule(rule, {
    kind: 'youtube-mention', mention, alpha: fadeAlpha,
    heldTickers: new Set(['TSLA']), watchMatches: [],
  })
  assert.ok(hit)
  assert.equal(hit.dedupKey, 'fc:12:42')
  assert.match(hit.message, /Fade candidate/)

  assert.equal(evaluateRule(rule, {
    kind: 'youtube-mention', mention, alpha: fadeAlpha,
    heldTickers: new Set(), watchMatches: [],
  }), null)
  assert.equal(evaluateRule(rule, {
    kind: 'youtube-mention', mention, alpha: followAlpha,
    heldTickers: new Set(['TSLA']), watchMatches: [],
  }), null)
})
