import test from 'node:test'
import assert from 'node:assert/strict'
import { segmentTranscript } from '../server/influence/transcripts.js'
import { resolveAssetMentionsInText } from '../server/influence/entityResolution.js'
import { mentionQualityScore } from '../server/influence/mentionQuality.js'
import { calculateDirectionalReturn } from '../server/backtest/youtubeBacktest.js'
import {
  db,
  createContentDocument,
  createYoutubeChannel,
  insertContentSegments,
  listAssetMentions,
  upsertYoutubeVideo,
} from '../server/db.js'
import { detectAndStoreYoutubeMentions } from '../server/influence/youtubeMentionDetection.js'

const aliases = [
  { asset_id: 1, symbol: 'TSLA', canonical_name: 'Tesla Inc.', asset_type: 'equity', alias: '$TSLA' },
  { asset_id: 1, symbol: 'TSLA', canonical_name: 'Tesla Inc.', asset_type: 'equity', alias: 'Tesla' },
  { asset_id: 2, symbol: 'AAPL', canonical_name: 'Apple Inc.', asset_type: 'equity', alias: 'Apple' },
  { asset_id: 3, symbol: 'SOL', canonical_name: 'Solana', asset_type: 'crypto', alias: 'Solana' },
  { asset_id: 3, symbol: 'SOL', canonical_name: 'Solana', asset_type: 'crypto', alias: 'SOL' },
]

test('segments SRT transcripts with timestamps', () => {
  const srt = `1
00:00:01,000 --> 00:00:05,000
I am buying more Nvidia here.

2
00:00:05,000 --> 00:00:08,000
Bitcoin is too risky at this level.`
  const segments = segmentTranscript(srt, 'srt')
  assert.equal(segments.length, 2)
  assert.equal(segments[0].start_seconds, 1)
  assert.equal(segments[0].end_seconds, 5)
  assert.match(segments[1].text, /Bitcoin/)
})

test('detects cashtags and financial company mentions', () => {
  assert.equal(resolveAssetMentionsInText('$TSLA is going to rip', aliases)[0].asset.symbol, 'TSLA')
  assert.equal(resolveAssetMentionsInText('Tesla stock is undervalued', aliases)[0].asset.symbol, 'TSLA')
})

test('filters common ambiguous false positives', () => {
  assert.equal(resolveAssetMentionsInText('I ate an apple pie', aliases).length, 0)
  assert.equal(resolveAssetMentionsInText('the solution is obvious', aliases).length, 0)
  assert.equal(resolveAssetMentionsInText('Solana looks strong against ETH', aliases)[0].asset.symbol, 'SOL')
})

test('mention quality clamps weighted score', () => {
  const score = mentionQualityScore({
    directnessScore: 90,
    convictionScore: 90,
    relevanceScore: 80,
    freshnessScore: 80,
    liquidityScore: 70,
    sponsorshipRiskScore: 10,
    pumpRiskScore: 10,
  })
  assert.ok(score > 50)
  assert.ok(score <= 100)
})

test('directional returns mirror bullish and bearish mentions', () => {
  assert.equal(calculateDirectionalReturn('bullish', 100, 110), 10)
  assert.equal(calculateDirectionalReturn('bearish', 100, 90), 10)
  assert.equal(calculateDirectionalReturn('bearish', 100, 110), -10)
})

function withRollback(fn) {
  const tx = db.transaction(() => {
    fn()
    throw new Error('ROLLBACK')
  })
  try {
    tx()
  } catch (err) {
    if (err.message !== 'ROLLBACK') throw err
  }
}

test('YouTube analysis refuses videos with no transcript segments', () => {
  withRollback(() => {
    const channel = createYoutubeChannel({
      youtube_channel_id: 'test-empty-analysis-channel',
      title: 'Test Empty Analysis Channel',
    })
    const video = upsertYoutubeVideo({
      youtube_video_id: 'test-empty-analysis-video',
      channel_id: channel.id,
      title: 'Empty Analysis Video',
      published_at: '2026-07-09T12:00:00Z',
    })

    assert.throws(
      () => detectAndStoreYoutubeMentions(video),
      /transcript required before analysis/
    )
  })
})

test('YouTube analysis stores asset mentions from uploaded transcript segments', () => {
  withRollback(() => {
    const channel = createYoutubeChannel({
      youtube_channel_id: 'test-analysis-channel',
      title: 'Test Analysis Channel',
    })
    const video = upsertYoutubeVideo({
      youtube_video_id: 'test-analysis-video',
      channel_id: channel.id,
      title: 'Analysis Video',
      published_at: '2026-07-09T12:00:00Z',
    })
    const rawText = 'Nvidia stock looks strong and I am adding $NVDA to the portfolio.'
    const documentId = createContentDocument({
      source_type: 'youtube_video',
      source_id: video.id,
      provider_name: 'manual',
      raw_text: rawText,
      source_format: 'plain_text',
      authorization_status: 'manual_upload',
    })
    insertContentSegments(documentId, segmentTranscript(rawText, 'plain_text'))

    const detection = detectAndStoreYoutubeMentions(video)
    const mentions = listAssetMentions({ videoId: video.id })

    assert.ok(detection.detected >= 1)
    assert.ok(detection.stored >= 1)
    assert.ok(mentions.some((mention) => mention.symbol === 'NVDA'))
  })
})
