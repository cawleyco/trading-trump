import { config } from '../config.js';
import { listYoutubeCollectionCoverage } from '../db.js';
import { queueChannelBackfill } from './youtubeIngestion.js';

const DIRECT_CATEGORIES = new Set(['stocks', 'crypto', 'trading', 'finance']);
const CONTROL_CATEGORIES = new Set(['education', 'personal-finance']);

function subtractMonthsIso(nowMs, months) {
  const date = new Date(nowMs);
  date.setUTCMonth(date.getUTCMonth() - months);
  return date.toISOString().slice(0, 10);
}

export function scoreCollectionChannel(row, targets, nowMs = Date.now()) {
  const known = Number(row.known_videos || 0);
  const transcripts = Number(row.transcript_videos || 0);
  const analyzed = Number(row.analyzed_videos || 0);
  const queued = Number(row.queued_videos || 0);
  const videoGap = Math.max(0, targets.videosPerChannel - known);
  const videoGapRatio = Math.min(1, videoGap / Math.max(1, targets.videosPerChannel));
  const transcriptCoverage = known ? transcripts / known : 0;
  const analysisCoverage = known ? analyzed / known : 0;
  const desiredOldest = subtractMonthsIso(nowMs, targets.historyMonths);
  const historyComplete = !!row.oldest_known_video && row.oldest_known_video.slice(0, 10) <= desiredOldest;
  const category = String(row.category || '').toLowerCase();
  const categoryWeight = DIRECT_CATEGORIES.has(category) ? 15 : CONTROL_CATEGORIES.has(category) ? 3 : 8;
  const tierWeight = row.influence_tier === 'large' || row.influence_tier === 'mega' ? 8 : 4;
  const blockedReasons = [];
  if (!row.tracking_enabled) blockedReasons.push('tracking_disabled');
  if (!row.uploads_playlist_id) blockedReasons.push('missing_uploads_playlist');
  const needsCollection = videoGap > 0 || !historyComplete;
  const score = needsCollection
    ? Math.round(
        videoGapRatio * 45 +
        (historyComplete ? 0 : 20) +
        (1 - transcriptCoverage) * 8 +
        categoryWeight + tierWeight -
        Math.min(15, queued / 10)
      )
    : 0;
  return {
    ...row,
    known_videos: known,
    transcript_videos: transcripts,
    analyzed_videos: analyzed,
    queued_videos: queued,
    videoGap,
    transcriptCoverage,
    analysisCoverage,
    desiredOldest,
    historyComplete,
    needsCollection,
    priorityScore: Math.max(0, score),
    blockedReasons,
    eligible: needsCollection && blockedReasons.length === 0,
  };
}

export function buildYoutubeCollectionPlan({ nowMs = Date.now(), targets = {}, rows = null } = {}) {
  const resolvedTargets = {
    videosPerChannel: Math.max(1, Number(targets.videosPerChannel || config.influence.collectionTargetVideosPerChannel)),
    historyMonths: Math.max(1, Number(targets.historyMonths || config.influence.collectionTargetHistoryMonths)),
  };
  const channels = (rows || listYoutubeCollectionCoverage())
    .map((row) => scoreCollectionChannel(row, resolvedTargets, nowMs))
    .sort((a, b) => b.priorityScore - a.priorityScore || b.videoGap - a.videoGap || a.title.localeCompare(b.title));
  const totals = channels.reduce((out, row) => {
    out.knownVideos += row.known_videos;
    out.transcriptVideos += row.transcript_videos;
    out.analyzedVideos += row.analyzed_videos;
    out.queuedVideos += row.queued_videos;
    out.directionalSignals += Number(row.directional_video_assets || 0);
    out.matureDirectionalSignals += Number(row.mature_directional_video_assets || 0);
    return out;
  }, { knownVideos: 0, transcriptVideos: 0, analyzedVideos: 0, queuedVideos: 0, directionalSignals: 0, matureDirectionalSignals: 0 });
  return {
    generatedAt: new Date(nowMs).toISOString(),
    targets: resolvedTargets,
    totals,
    eligibleChannels: channels.filter((row) => row.eligible).length,
    channels,
  };
}

export async function queueYoutubeCollectionPlan(options = {}, deps = {}) {
  const loadCoverage = deps.loadCoverage || listYoutubeCollectionCoverage;
  const queueBackfill = deps.queueBackfill || queueChannelBackfill;
  const nowMs = deps.nowMs || Date.now();
  const plan = buildYoutubeCollectionPlan({ targets: options.targets, rows: loadCoverage(), nowMs });
  const maxChannels = Math.min(
    config.influence.collectionBulkMaxChannels,
    Math.max(1, Number(options.maxChannels || config.influence.collectionBulkMaxChannels))
  );
  const totalCap = Math.min(
    config.influence.collectionBulkMaxVideos,
    Math.max(1, Number(options.maxVideos || config.influence.collectionBulkMaxVideos))
  );
  const perChannel = Math.max(1, Number(options.maxVideosPerChannel || 100));
  const selected = plan.channels.filter((row) => row.eligible).slice(0, maxChannels);
  const results = [];
  let queued = 0;
  for (const channel of selected) {
    const remaining = totalCap - queued;
    if (remaining <= 0) break;
    const maxVideos = Math.min(perChannel, remaining, Math.max(1, channel.videoGap || perChannel));
    try {
      const result = await queueBackfill(channel.id, {
        maxVideos,
        publishedAfter: channel.desiredOldest,
      });
      queued += result.queued;
      results.push({ channelId: channel.id, title: channel.title, priorityScore: channel.priorityScore, ...result });
    } catch (err) {
      results.push({ channelId: channel.id, title: channel.title, priorityScore: channel.priorityScore, error: err.message });
    }
  }
  return { queued, maxChannels, totalCap, selected: selected.length, results, plan: buildYoutubeCollectionPlan({ rows: loadCoverage(), nowMs }) };
}
