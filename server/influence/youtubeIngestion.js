// YouTube ingestion pipeline: channel sync → transcript → mention detection →
// classification → research signals. Extracted from the route handlers so the
// poller (server/sources/youtubePoller.js) and the API routes share one code
// path. Errors carry .httpStatus so route wrappers can answer 4xx precisely.
import fs from 'node:fs';
import { config } from '../config.js';
import { log } from '../logger.js';
import {
  getYoutubeChannel,
  getYoutubeChannelByYoutubeId,
  updateYoutubeChannel,
  upsertYoutubeChannel,
  insertYoutubeChannelSnapshot,
  markYoutubeChannelSynced,
  upsertYoutubeVideo,
  insertYoutubeVideoSnapshot,
  getYoutubeVideo,
  getYoutubeVideoByYoutubeId,
  updateYoutubeVideoStatuses,
  recordYoutubeTranscriptAttempt,
  createContentDocument,
  insertContentSegments,
  listAssetMentions,
} from '../db.js';
import {
  getChannelMetadata,
  getVideoMetadata,
  listLatestVideosFromUploadsPlaylist,
  listUploadsPlaylistPage,
  resolveChannelId,
} from '../sources/youtubeApiClient.js';
import { TranscriptProviderRegistry } from './transcripts.js';
import { YtDlpTranscriptProvider } from './transcriptProviders/ytDlpProvider.js';
import { detectAndStoreYoutubeMentions } from './youtubeMentionDetection.js';
import { classifyAndStoreYoutubeMention } from './youtubeMentionClassifier.js';
import { generateYoutubeSignals } from './youtubeSignals.js';

function httpError(status, message) {
  const err = new Error(message);
  err.httpStatus = status;
  return err;
}

let _defaultRegistry = null;
export function defaultTranscriptRegistry() {
  if (!_defaultRegistry) {
    _defaultRegistry = new TranscriptProviderRegistry([new YtDlpTranscriptProvider()]);
  }
  return _defaultRegistry;
}

export async function syncChannel(channelId, { maxResults, refreshMetadata = false } = {}) {
  const channel = getYoutubeChannel(channelId);
  if (!channel) throw httpError(404, 'channel not found');
  let current = channel;
  if (!channel.uploads_playlist_id || refreshMetadata) {
    const metadata = await getChannelMetadata(channel.youtube_channel_id);
    current = updateYoutubeChannel(channelId, metadata);
    insertYoutubeChannelSnapshot(channelId, current);
  }
  if (!current.uploads_playlist_id) {
    throw httpError(400, 'channel has no uploads playlist id');
  }
  const latest = await listLatestVideosFromUploadsPlaylist(
    current.uploads_playlist_id,
    Number(maxResults) || config.influence.syncMaxResults
  );
  const videos = [];
  for (const item of latest) {
    let full = item;
    try {
      full = { ...item, ...(await getVideoMetadata(item.youtube_video_id)) };
    } catch (err) {
      log.warn('youtube', `Video metadata failed for ${item.youtube_video_id}: ${err.message}`);
    }
    // Never demote a video that already progressed past metadata_fetched
    // (e.g. an ingested backfill video reappearing in the latest-uploads page).
    const existing = getYoutubeVideoByYoutubeId(item.youtube_video_id);
    const video = upsertYoutubeVideo({
      ...full,
      channel_id: channelId,
      ingestion_status: existing?.ingestion_status && existing.ingestion_status !== 'pending'
        ? existing.ingestion_status
        : 'metadata_fetched',
    });
    if (full.stats) insertYoutubeVideoSnapshot(video.id, full.stats);
    videos.push(video);
  }
  markYoutubeChannelSynced(channelId);
  return { channel: getYoutubeChannel(channelId), videos };
}

export function storeTranscript(video, transcript, { authorizationStatus } = {}) {
  const documentId = createContentDocument({
    source_type: 'youtube_video',
    source_id: video.id,
    provider_name: transcript.providerName,
    language: transcript.language,
    raw_text: transcript.rawText,
    source_format: transcript.format,
    authorization_status: authorizationStatus || transcript.authorizationStatus || 'unknown',
  });
  insertContentSegments(documentId, transcript.segments);
  updateYoutubeVideoStatuses(video.id, { transcript_status: 'available' });
  return documentId;
}

export function analyzeVideo(video) {
  const detection = detectAndStoreYoutubeMentions(video);
  updateYoutubeVideoStatuses(video.id, { analysis_status: 'complete' });
  return detection;
}

export async function classifyVideoMentions(video, { limit = 500 } = {}) {
  const mentions = listAssetMentions({ videoId: video.id, limit });
  let classified = 0;
  for (const mention of mentions) {
    const classification = await classifyAndStoreYoutubeMention(mention, {
      videoTitle: video.title,
      videoDescription: video.description,
      channelTitle: video.channel_title,
      hasPaidProductPlacement: video.has_paid_product_placement,
    });
    if (classification) classified++;
  }
  return { mentions: mentions.length, classified };
}

// One video, end to end: transcript → detect → classify → research signals.
// Returns a status summary; never throws for per-video data problems (the
// poller must survive one bad video), only for programmer errors.
export async function ingestVideo(videoOrId, { registry = defaultTranscriptRegistry() } = {}) {
  const video = typeof videoOrId === 'object' ? videoOrId : getYoutubeVideo(videoOrId);
  if (!video) throw httpError(404, 'video not found');

  if (video.transcript_status !== 'available') {
    // No eligible provider (e.g. auto transcripts disabled) must not burn the
    // retry budget — the video waits untouched until a provider can try.
    if (!(await registry.hasEligibleProvider(video))) {
      return { videoId: video.id, status: 'no_provider' };
    }
    recordYoutubeTranscriptAttempt(video.id);
    let result;
    try {
      result = await registry.fetchBestAvailableTranscript(video);
    } catch (err) {
      result = { status: 'error', errorMessage: err.message };
    }
    if (result.status !== 'success') {
      const attempts = (video.transcript_attempts ?? 0) + 1;
      const exhausted = attempts >= config.influence.transcriptMaxAttempts;
      updateYoutubeVideoStatuses(video.id, {
        transcript_status: exhausted ? 'unavailable' : 'pending',
        ingestion_status: exhausted ? 'ingest_failed' : video.ingestion_status,
      });
      log.info(
        'youtube',
        `No transcript for video ${video.id} (${video.youtube_video_id}): ` +
          `${result.errorMessage || result.status}, attempt ${attempts}/${config.influence.transcriptMaxAttempts}`
      );
      return { videoId: video.id, status: 'no_transcript', attempts, exhausted };
    }
    storeTranscript(video, result);
  }

  const fresh = getYoutubeVideo(video.id);
  let detection;
  try {
    detection = analyzeVideo(fresh);
  } catch (err) {
    updateYoutubeVideoStatuses(video.id, { analysis_status: 'failed', ingestion_status: 'ingest_failed' });
    log.error('youtube', `Analysis failed for video ${video.id}: ${err.message}`);
    return { videoId: video.id, status: 'analysis_failed', error: err.message };
  }
  const classification = await classifyVideoMentions(fresh);
  const signals = generateYoutubeSignals({ videoId: video.id });
  updateYoutubeVideoStatuses(video.id, { ingestion_status: 'ingested' });
  return {
    videoId: video.id,
    status: 'ingested',
    detected: detection.stored,
    classified: classification.classified,
    signals: signals.length,
  };
}

// Backfill: page the uploads playlist beyond the sync window and queue older
// videos as backfill_pending; the poller drains them oldest-first.
export async function queueChannelBackfill(channelId, { maxVideos = 100, publishedAfter } = {}) {
  const channel = getYoutubeChannel(channelId);
  if (!channel) throw httpError(404, 'channel not found');
  if (!channel.uploads_playlist_id) throw httpError(400, 'channel has no uploads playlist id — sync the channel first');
  const cutoff = publishedAfter ? new Date(publishedAfter).getTime() : null;
  let queued = 0;
  let scanned = 0;
  let pageToken = null;
  let done = false;
  do {
    const page = await listUploadsPlaylistPage(channel.uploads_playlist_id, { pageToken });
    pageToken = page.nextPageToken;
    for (const item of page.items) {
      scanned++;
      if (cutoff && new Date(item.published_at).getTime() < cutoff) {
        done = true; // uploads playlists are newest-first — everything past here is older
        break;
      }
      if (getYoutubeVideoByYoutubeId(item.youtube_video_id)) continue; // already known — don't clobber its status
      upsertYoutubeVideo({ ...item, channel_id: channelId, ingestion_status: 'backfill_pending' });
      queued++;
      if (queued >= maxVideos) {
        done = true;
        break;
      }
    }
  } while (!done && pageToken);
  return { channelId, scanned, queued };
}

// Idempotent roster seeding: resolve each handle once, skip channels already
// in the DB. Requires the YouTube API key only for entries not yet resolved.
export function loadYoutubeRoster(rosterPath) {
  if (!fs.existsSync(rosterPath)) return [];
  return JSON.parse(fs.readFileSync(rosterPath, 'utf8'));
}

export async function seedYoutubeRoster(roster) {
  let seeded = 0;
  let skipped = 0;
  const errors = [];
  for (const entry of roster) {
    try {
      if (entry.youtube_channel_id && getYoutubeChannelByYoutubeId(entry.youtube_channel_id)) {
        skipped++;
        continue;
      }
      const channelId = entry.youtube_channel_id || (await resolveChannelId(entry.handle));
      if (getYoutubeChannelByYoutubeId(channelId)) {
        skipped++;
        continue;
      }
      const metadata = await getChannelMetadata(channelId);
      upsertYoutubeChannel({
        ...metadata,
        youtube_channel_id: channelId,
        title: metadata.title || entry.title,
        category: entry.category ?? null,
        influence_tier: entry.influence_tier ?? null,
        risk_notes: entry.risk_notes ?? null,
      });
      seeded++;
    } catch (err) {
      errors.push({ handle: entry.handle, error: err.message });
      log.warn('youtube', `Roster seed failed for ${entry.handle}: ${err.message}`);
    }
  }
  if (seeded || errors.length) {
    log.info('youtube', `Roster seed: ${seeded} added, ${skipped} already present, ${errors.length} failed`);
  }
  return { seeded, skipped, errors };
}
