import test from 'node:test'
import assert from 'node:assert/strict'
import {
  _entryPrice,
  _exitPrice,
  _median,
  _resultForMention,
  consolidateYoutubeMentions,
  recalculateCreatorAlpha,
  runYoutubeBacktest,
} from '../server/backtest/youtubeBacktest.js'
import {
  db,
  createAssetMention,
  createMentionClassification,
  createYoutubeChannel,
  getAssetBySymbol,
  listAllAssetMentions,
  upsertYoutubeVideo,
} from '../server/db.js'

// Mention at 14:00Z on a trading day; minute bars cover entry and +1h.
const EVENT_TIME = '2026-06-15T14:00:00Z'
const EVENT_MS = new Date(EVENT_TIME).getTime()

const minuteBars = [
  { timestamp: '2026-06-15T14:00:00Z', open: 100, close: 100.5 },
  { timestamp: '2026-06-15T15:00:00Z', open: 104.5, close: 105 },
]

const dailyBars = [
  { date: '2026-06-15', open: 99, close: 106 },
  { date: '2026-06-16', open: 107, close: 108 },
  { date: '2026-06-22', open: 111, close: 112 },
  { date: '2026-07-15', open: 119, close: 120 },
]

const spyBars = [
  { date: '2026-06-15', open: 499, close: 500 },
  { date: '2026-07-15', open: 509, close: 510 },
]

const fixtureProvider = {
  async minuteBars(symbol) {
    return symbol === 'TSLA' ? minuteBars : []
  },
  async dailyCloses(symbol) {
    return symbol === 'SPY' ? spyBars : dailyBars
  },
}

const noDataProvider = {
  async minuteBars() { return null },
  async dailyCloses() { return null },
}

test('median averages the two middle values on even-length input', () => {
  assert.equal(_median([3, 1, 2]), 2)
  assert.equal(_median([-1, 0, 2, 5]), 1)
  assert.equal(_median([5, null, 1, 'x']), 3)
  assert.equal(_median([]), null)
})

test('entry uses the first minute bar at or after the mention time', () => {
  const { price, source } = _entryPrice({ minuteBars, dailyBars, eventMs: EVENT_MS })
  assert.equal(price, 100)
  assert.equal(source, 'minute')
})

test('off-hours entry falls back to the NEXT day open, never the same-day close', () => {
  // 23:00Z mention: the 2026-06-15 close printed before the mention, so using
  // it would be look-ahead. Entry must be 2026-06-16's open.
  const eventMs = new Date('2026-06-15T23:00:00Z').getTime()
  const { price, source } = _entryPrice({ minuteBars: [], dailyBars, eventMs })
  assert.equal(price, 107)
  assert.equal(source, 'daily-open')
})

test('entry is null when no price data exists', () => {
  assert.equal(_entryPrice({ minuteBars: null, dailyBars: null, eventMs: EVENT_MS }).price, null)
})

test('intraday exits require a minute-bar entry', () => {
  const oneHour = 1 / 24
  assert.equal(
    _exitPrice({ minuteBars, dailyBars, eventMs: EVENT_MS, windowDays: oneHour, entrySource: 'minute' }),
    105
  )
  assert.equal(
    _exitPrice({ minuteBars, dailyBars, eventMs: EVENT_MS, windowDays: oneHour, entrySource: 'daily-open' }),
    null
  )
})

test('daily exits roll forward to the first close on or after the target date', () => {
  // 7d after 2026-06-15 is Monday 2026-06-22 in the fixture
  assert.equal(_exitPrice({ minuteBars, dailyBars, eventMs: EVENT_MS, windowDays: 7, entrySource: 'minute' }), 112)
  // 3d lands on 2026-06-18 with no bar — rolls to 2026-06-22
  assert.equal(_exitPrice({ minuteBars, dailyBars, eventMs: EVENT_MS, windowDays: 3, entrySource: 'minute' }), 112)
  // beyond available data
  assert.equal(_exitPrice({ minuteBars, dailyBars, eventMs: EVENT_MS, windowDays: 90, entrySource: 'minute' }), null)
})

test('result computes directional returns and SPY benchmark from real series', () => {
  const mention = { id: 1, asset_id: 1, event_time: EVENT_TIME, direction: 'bullish' }
  const r = _resultForMention(mention, ['1h', '24h', '7d', '30d'], {
    minuteBars,
    dailyBars,
    benchmarkBars: spyBars,
  })
  assert.equal(r.entry_price, 100)
  assert.equal(r.return_1h, 5)
  assert.equal(r.return_24h, 8)
  assert.equal(r.return_7d, 12)
  assert.equal(r.return_30d, 20)
  assert.equal(r.benchmark_return_30d, 2)
  assert.equal(r.result_metadata.priceSource, 'minute')
  assert.equal(r.result_metadata.noPriceData, false)

  const bearish = _resultForMention({ ...mention, direction: 'bearish' }, ['24h'], {
    minuteBars,
    dailyBars,
    benchmarkBars: spyBars,
  })
  assert.equal(bearish.return_24h, -8)
})

test('missing price data yields null returns, not fabricated ones', () => {
  const mention = { id: 1, asset_id: 1, event_time: EVENT_TIME, direction: 'bullish' }
  const r = _resultForMention(mention, ['1h', '30d'], {
    minuteBars: null,
    dailyBars: null,
    benchmarkBars: null,
  })
  assert.equal(r.entry_price, null)
  assert.equal(r.return_1h, null)
  assert.equal(r.return_30d, null)
  assert.equal(r.benchmark_return_30d, null)
  assert.equal(r.result_metadata.noPriceData, true)
})

test('outcome metadata distinguishes immature horizons from missing prices', () => {
  const mention = { id: 1, asset_id: 1, event_time: EVENT_TIME, direction: 'bullish' }
  const beforeThirtyDays = EVENT_MS + 10 * 86400_000
  const r = _resultForMention(mention, ['7d', '30d'], {
    minuteBars,
    dailyBars,
    benchmarkBars: spyBars,
    nowMs: beforeThirtyDays,
  })
  assert.equal(r.result_metadata.outcomeStatus['7d'], 'measured')
  assert.equal(r.result_metadata.outcomeStatus['30d'], 'immature')
  assert.equal(r.return_30d, null)
})

test('30-day drawdown and runup use the complete directional price path', () => {
  const mention = { id: 1, asset_id: 1, event_time: EVENT_TIME, direction: 'bullish' }
  const path = [
    { date: '2026-06-15', close: 90 },
    { date: '2026-06-20', close: 110 },
    { date: '2026-06-25', close: 80 },
    { date: '2026-07-15', close: 120 },
  ]
  const r = _resultForMention(mention, ['30d'], {
    minuteBars,
    dailyBars: path,
    benchmarkBars: spyBars,
    nowMs: EVENT_MS + 31 * 86400_000,
  })
  assert.equal(r.max_drawdown_30d, -20)
  assert.equal(r.max_runup_30d, 20)
})

test('consolidation clusters repeats and conservatively retains direction conflicts', () => {
  const base = { video_id: 10, channel_id: 20, asset_id: 30, symbol: 'TSLA', entity_confidence: 0.9 }
  const rows = [
    { ...base, id: 1, event_time: '2026-06-15T14:00:00Z', direction: 'bullish', mention_quality_score: 20 },
    { ...base, id: 2, event_time: '2026-06-15T14:00:20Z', direction: 'bullish', mention_quality_score: 60 },
    { ...base, id: 3, event_time: '2026-06-15T14:02:00Z', direction: 'bearish', mention_quality_score: 50 },
  ]
  const [signal] = consolidateYoutubeMentions(rows, { persist: false })
  assert.equal(signal.direction, 'mixed')
  assert.equal(signal.conflict_status, 'direction_conflict')
  assert.equal(signal.occurrence_count, 3)
  assert.equal(signal.collapsed_cluster_count, 2)
  assert.deepEqual(signal.mention_ids, [1, 2, 3])
})

// ---------------------------------------------------------------------------
// DB-backed integration. runYoutubeBacktest is async so the sync-transaction
// rollback trick doesn't apply — fixture rows are deleted in `finally`.
// ---------------------------------------------------------------------------

function insertFixtureMention({ channelKey, direction = 'bullish' }) {
  const channel = createYoutubeChannel({
    youtube_channel_id: channelKey,
    title: 'Backtest Fixture Channel',
  })
  const video = upsertYoutubeVideo({
    youtube_video_id: `${channelKey}-video`,
    channel_id: channel.id,
    title: 'Backtest Fixture Video',
    published_at: EVENT_TIME,
  })
  const asset = getAssetBySymbol('TSLA')
  const mentionId = createAssetMention({
    asset_id: asset.id,
    source_type: 'youtube_video',
    source_id: video.id,
    video_id: video.id,
    channel_id: channel.id,
    mention_text: `${channelKey} fixture mention`,
    event_time: EVENT_TIME,
    entity_confidence: 0.95,
  })
  createMentionClassification({
    mention_id: mentionId,
    direction,
    conviction_score: 80,
    relevance_score: 80,
    directness_score: 80,
    sponsorship_risk_score: 5,
    pump_risk_score: 5,
    mention_type: 'recommendation',
    summary: 'fixture',
    should_create_signal: false,
    mention_quality_score: 75,
  })
  return { channel, video, mentionId }
}

function deleteFixtureRows({ channel, video, mentionId, runId }) {
  if (runId) {
    db.prepare(`DELETE FROM youtube_backtest_price_observations WHERE backtest_run_id = ?`).run(runId)
    db.prepare(`DELETE FROM youtube_backtest_signal_results WHERE backtest_run_id = ?`).run(runId)
    db.prepare(`DELETE FROM youtube_backtest_runs WHERE id = ?`).run(runId)
  }
  db.prepare(`DELETE FROM creator_alpha_metrics WHERE channel_id = ?`).run(channel.id)
  db.prepare(`DELETE FROM youtube_canonical_signals WHERE video_id = ?`).run(video.id)
  db.prepare(`DELETE FROM mention_classifications WHERE mention_id = ?`).run(mentionId)
  db.prepare(`DELETE FROM asset_mentions WHERE id = ?`).run(mentionId)
  db.prepare(`DELETE FROM youtube_videos WHERE id = ?`).run(video.id)
  db.prepare(`DELETE FROM youtube_channels WHERE id = ?`).run(channel.id)
}

test('runYoutubeBacktest persists results priced from the injected provider', async () => {
  const fixture = insertFixtureMention({ channelKey: 'bt-fixture-run' })
  let runId = null
  try {
    const run = await runYoutubeBacktest(
      { name: 'fixture run', videoId: fixture.video.id, limit: 10 },
      { provider: fixtureProvider }
    )
    runId = run.id
    assert.equal(run.status, 'complete')
    assert.equal(run.results.length, 1)
    const result = run.results[0]
    assert.equal(result.entry_price, 100)
    assert.equal(result.return_1h, 5)
    assert.equal(result.return_30d, 20)
    assert.equal(result.result_metadata.priceSource, 'minute')
    assert.equal(result.result_metadata.priceProvider, 'injected')
    const snapshots = db.prepare(
      `SELECT interval, COUNT(*) n FROM youtube_backtest_price_observations WHERE backtest_run_id=? GROUP BY interval`
    ).all(runId)
    assert.ok(snapshots.some((row) => row.n > 0), 'the run preserves the exact provider bars it used')
    assert.equal(run.summary.priced, 1)
    assert.equal(run.summary.noPriceData, 0)
    // The filter funnel explains small samples (total → directional → filtered)
    assert.equal(run.summary.funnel.withDirection, 1)
    assert.equal(run.summary.funnel.afterQualityFilters, 1)
    assert.ok(run.summary.funnel.mentionsTotal >= 1)
  } finally {
    deleteFixtureRows({ ...fixture, runId })
  }
})

test('mention paging and date filters are applied by the database query', () => {
  const fixture = insertFixtureMention({ channelKey: 'bt-fixture-paging' })
  let secondMentionId = null
  let secondVideo = null
  try {
    secondVideo = upsertYoutubeVideo({
      youtube_video_id: 'bt-fixture-paging-video-2',
      channel_id: fixture.channel.id,
      title: 'Older fixture video',
      published_at: '2026-05-01T12:00:00Z',
    })
    const asset = getAssetBySymbol('TSLA')
    secondMentionId = createAssetMention({
      asset_id: asset.id, source_type: 'youtube_video', source_id: secondVideo.id,
      video_id: secondVideo.id, channel_id: fixture.channel.id, mention_text: 'older paging fixture',
      event_time: '2026-05-01T12:00:00Z', entity_confidence: 0.9,
    })
    const all = listAllAssetMentions({ channelId: fixture.channel.id }, { pageSize: 1 })
    assert.equal(all.length, 2)
    const june = listAllAssetMentions({ channelId: fixture.channel.id, startDate: '2026-06-01', endDate: '2026-06-30' }, { pageSize: 1 })
    assert.deepEqual(june.map((m) => m.id), [fixture.mentionId])
  } finally {
    if (secondMentionId) db.prepare(`DELETE FROM asset_mentions WHERE id=?`).run(secondMentionId)
    if (secondVideo) db.prepare(`DELETE FROM youtube_videos WHERE id=?`).run(secondVideo.id)
    deleteFixtureRows({ ...fixture, runId: null })
  }
})

test('runYoutubeBacktest records unpriceable mentions as no-data instead of inventing prices', async () => {
  const fixture = insertFixtureMention({ channelKey: 'bt-fixture-nodata' })
  let runId = null
  try {
    const run = await runYoutubeBacktest(
      { name: 'no-data run', videoId: fixture.video.id, limit: 10 },
      { provider: noDataProvider }
    )
    runId = run.id
    assert.equal(run.results[0].entry_price, null)
    assert.equal(run.results[0].result_metadata.noPriceData, true)
    assert.equal(run.summary.priced, 0)
    assert.equal(run.summary.noPriceData, 1)
    assert.match(run.summary.warning, /unreliable/i)
  } finally {
    deleteFixtureRows({ ...fixture, runId })
  }
})

test('creator alpha ignores data gaps instead of counting them as losses', async () => {
  const fixture = insertFixtureMention({ channelKey: 'bt-fixture-alpha' })
  try {
    const noData = await recalculateCreatorAlpha(fixture.channel.id, { provider: noDataProvider })
    assert.equal(noData.sampleSize, 1)
    assert.equal(noData.measurable, 0)
    // Below the minimum sample, alpha is NULL — unknown, not zero.
    assert.equal(noData.alphaScore, null)
    assert.equal(noData.label, 'insufficient_data')

    const priced = await recalculateCreatorAlpha(fixture.channel.id, { provider: fixtureProvider })
    assert.equal(priced.measurable, 1)
    // 1 measurable mention is still below the 10-mention trust floor
    assert.equal(priced.label, 'insufficient_data')
    assert.equal(priced.alphaScore, null)
  } finally {
    deleteFixtureRows({ ...fixture, runId: null })
  }
})
