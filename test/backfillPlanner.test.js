import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildYoutubeCollectionPlan,
  queueYoutubeCollectionPlan,
  scoreCollectionChannel,
} from '../server/influence/backfillPlanner.js'

const NOW = new Date('2026-07-22T12:00:00Z').getTime()

function channel(id, overrides = {}) {
  return {
    id,
    title: `Channel ${id}`,
    category: 'stocks',
    influence_tier: 'mid',
    tracking_enabled: 1,
    uploads_playlist_id: `uploads-${id}`,
    known_videos: 20,
    transcript_videos: 10,
    analyzed_videos: 10,
    queued_videos: 0,
    failed_videos: 0,
    directional_video_assets: 5,
    mature_directional_video_assets: 2,
    oldest_known_video: '2026-01-01T00:00:00Z',
    newest_known_video: '2026-07-01T00:00:00Z',
    ...overrides,
  }
}

test('collection priority favours direct-call channels with large video/history gaps', () => {
  const targets = { videosPerChannel: 200, historyMonths: 24 }
  const direct = scoreCollectionChannel(channel(1), targets, NOW)
  const control = scoreCollectionChannel(channel(2, { category: 'education' }), targets, NOW)
  const nearlyComplete = scoreCollectionChannel(channel(3, {
    known_videos: 195,
    transcript_videos: 190,
    analyzed_videos: 190,
    oldest_known_video: '2024-01-01T00:00:00Z',
  }), targets, NOW)
  assert.ok(direct.priorityScore > control.priorityScore)
  assert.ok(control.priorityScore > nearlyComplete.priorityScore)
  assert.equal(direct.desiredOldest, '2024-07-22')
})

test('channels without an uploads playlist are visible but blocked from queueing', () => {
  const plan = buildYoutubeCollectionPlan({
    nowMs: NOW,
    targets: { videosPerChannel: 200, historyMonths: 24 },
    rows: [channel(1, { uploads_playlist_id: null })],
  })
  assert.equal(plan.eligibleChannels, 0)
  assert.deepEqual(plan.channels[0].blockedReasons, ['missing_uploads_playlist'])
})

test('bulk queue respects channel and total caps and passes the historical cutoff', async () => {
  const rows = [channel(1), channel(2), channel(3)]
  const calls = []
  const result = await queueYoutubeCollectionPlan(
    { maxChannels: 2, maxVideos: 15, maxVideosPerChannel: 10, targets: { videosPerChannel: 200, historyMonths: 24 } },
    {
      nowMs: NOW,
      loadCoverage: () => rows,
      queueBackfill: async (id, options) => {
        calls.push({ id, options })
        return { channelId: id, scanned: options.maxVideos, queued: options.maxVideos }
      },
    }
  )
  assert.equal(calls.length, 2)
  assert.deepEqual(calls.map((c) => c.options.maxVideos), [10, 5])
  assert.ok(calls.every((c) => c.options.publishedAfter === '2024-07-22'))
  assert.equal(result.queued, 15)
})
