import test from 'node:test'
import assert from 'node:assert/strict'
import { config } from '../server/config.js'
import {
  db,
  createYoutubeChannel,
  upsertYoutubeVideo,
  getYoutubeVideo,
  listYoutubeVideosPendingIngestion,
  countYoutubeVideosByStatus,
} from '../server/db.js'
import { TranscriptProviderRegistry, StubTranscriptProvider } from '../server/influence/transcripts.js'
import { ingestVideo } from '../server/influence/youtubeIngestion.js'

// Distinctive ids keep these rows disjoint from real data.
const CHANNEL_YT_ID = 'UC-test-ingestion-000000000'

function seedChannel({ trackingEnabled = true } = {}) {
  return createYoutubeChannel({
    youtube_channel_id: CHANNEL_YT_ID,
    title: 'Ingestion Test Channel',
    tracking_enabled: trackingEnabled,
  })
}

function seedVideo(channelId, ytId, overrides = {}) {
  return upsertYoutubeVideo({
    youtube_video_id: ytId,
    channel_id: channelId,
    title: `Test video ${ytId}`,
    published_at: overrides.published_at || '2026-07-01T12:00:00Z',
    ingestion_status: 'metadata_fetched',
    ...overrides,
  })
}

function cleanup() {
  const channel = db.prepare('SELECT id FROM youtube_channels WHERE youtube_channel_id = ?').get(CHANNEL_YT_ID)
  if (!channel) return
  const videoIds = db.prepare('SELECT id FROM youtube_videos WHERE channel_id = ?').all(channel.id).map((r) => r.id)
  for (const vid of videoIds) {
    db.prepare(`DELETE FROM content_segments WHERE document_id IN
      (SELECT id FROM content_documents WHERE source_type = 'youtube_video' AND source_id = ?)`).run(vid)
    db.prepare(`DELETE FROM content_documents WHERE source_type = 'youtube_video' AND source_id = ?`).run(vid)
    db.prepare('DELETE FROM asset_mentions WHERE video_id = ?').run(vid)
  }
  db.prepare('DELETE FROM youtube_videos WHERE channel_id = ?').run(channel.id)
  db.prepare('DELETE FROM youtube_channels WHERE id = ?').run(channel.id)
}

test('ingestVideo walks a video to ingested when a transcript is available', async (t) => {
  t.after(cleanup)
  const channel = seedChannel()
  const video = seedVideo(channel.id, 'ing-success-01')
  const registry = new TranscriptProviderRegistry([
    new StubTranscriptProvider(new Map([[String(video.id), 'Just market chatter, no tickers today.']])),
  ])

  const result = await ingestVideo(video, { registry })
  assert.equal(result.status, 'ingested')

  const fresh = getYoutubeVideo(video.id)
  assert.equal(fresh.transcript_status, 'available')
  assert.equal(fresh.analysis_status, 'complete')
  assert.equal(fresh.ingestion_status, 'ingested')
  assert.equal(fresh.transcript_attempts, 1)
  assert.ok(fresh.last_transcript_attempt_at)

  const doc = db.prepare(
    `SELECT * FROM content_documents WHERE source_type = 'youtube_video' AND source_id = ?`
  ).get(video.id)
  assert.ok(doc, 'transcript document stored')
})

test('ingestVideo counts attempts and marks the video unavailable once exhausted', async (t) => {
  t.after(cleanup)
  const channel = seedChannel()
  const video = seedVideo(channel.id, 'ing-notranscript-01')
  // Eligible provider that tries and fails — these failures DO burn attempts.
  const failingRegistry = new TranscriptProviderRegistry([{
    providerName: 'always-fails',
    canFetch: async () => true,
    fetchTranscript: async () => ({ status: 'unavailable', providerName: 'always-fails', errorMessage: 'no captions' }),
  }])

  for (let attempt = 1; attempt <= config.influence.transcriptMaxAttempts; attempt++) {
    const result = await ingestVideo(getYoutubeVideo(video.id), { registry: failingRegistry })
    assert.equal(result.status, 'no_transcript')
    assert.equal(result.attempts, attempt)
    assert.equal(result.exhausted, attempt === config.influence.transcriptMaxAttempts)
  }

  const fresh = getYoutubeVideo(video.id)
  assert.equal(fresh.transcript_status, 'unavailable')
  assert.equal(fresh.ingestion_status, 'ingest_failed')
  assert.equal(fresh.transcript_attempts, config.influence.transcriptMaxAttempts)
})

test('ingestVideo burns no retry budget when no provider is eligible (e.g. auto transcripts off)', async (t) => {
  t.after(cleanup)
  const channel = seedChannel()
  const video = seedVideo(channel.id, 'ing-noprovider-01')
  const emptyRegistry = new TranscriptProviderRegistry([])

  const result = await ingestVideo(video, { registry: emptyRegistry })
  assert.equal(result.status, 'no_provider')

  const fresh = getYoutubeVideo(video.id)
  assert.equal(fresh.transcript_attempts, 0, 'no attempt burned')
  assert.equal(fresh.transcript_status, 'not_requested', 'status untouched')
  assert.equal(fresh.ingestion_status, 'metadata_fetched', 'still queued for when a provider appears')
})

test('pending-ingestion queue: live drains newest-first, backfill oldest-first, exhausted excluded', (t) => {
  t.after(cleanup)
  const channel = seedChannel()
  const old = seedVideo(channel.id, 'q-old', { published_at: '2024-01-01T00:00:00Z', ingestion_status: 'backfill_pending' })
  const older = seedVideo(channel.id, 'q-older', { published_at: '2023-01-01T00:00:00Z', ingestion_status: 'backfill_pending' })
  const newer = seedVideo(channel.id, 'q-newer', { published_at: '2026-07-02T00:00:00Z' })
  const newest = seedVideo(channel.id, 'q-newest', { published_at: '2026-07-03T00:00:00Z' })
  const exhausted = seedVideo(channel.id, 'q-exhausted', { published_at: '2026-07-04T00:00:00Z' })
  db.prepare('UPDATE youtube_videos SET transcript_attempts = ? WHERE id = ?').run(99, exhausted.id)

  const live = listYoutubeVideosPendingIngestion({ limit: 10, maxAttempts: 3, channelId: channel.id })
  assert.deepEqual(live.map((v) => v.id), [newest.id, newer.id], 'newest first, exhausted excluded')

  const backfill = listYoutubeVideosPendingIngestion({ limit: 10, maxAttempts: 3, backfill: true, channelId: channel.id })
  assert.deepEqual(backfill.map((v) => v.id), [older.id, old.id], 'oldest first')

  const capped = listYoutubeVideosPendingIngestion({ limit: 1, maxAttempts: 3, backfill: true, channelId: channel.id })
  assert.equal(capped.length, 1, 'per-run cap respected')

  const statuses = countYoutubeVideosByStatus(channel.id)
  assert.equal(statuses.reduce((sum, s) => sum + s.count, 0), 5)
})

test('pending-ingestion queue skips channels with tracking disabled', (t) => {
  t.after(cleanup)
  const channel = seedChannel({ trackingEnabled: false })
  seedVideo(channel.id, 'q-untracked')
  const live = listYoutubeVideosPendingIngestion({ limit: 100, maxAttempts: 3, channelId: channel.id })
  assert.equal(live.length, 0)
})
