// YouTube channel poller: keeps tracked finfluencer channels ingesting
// themselves. Mirrors congressPoller.js — cron-driven, firstRun seeds without
// alerting, per-run caps bound API quota and LLM spend. Live videos are
// processed newest-first; backfill_pending videos drain oldest-first at a
// slower rate on the same schedule.
import cron from 'node-cron';
import { config } from '../config.js';
import { listYoutubeChannels, listYoutubeVideosPendingIngestion, listAssetMentions, getCreatorAlpha } from '../db.js';
import { syncChannel, ingestVideo, loadYoutubeRoster, seedYoutubeRoster } from '../influence/youtubeIngestion.js';
import { dispatchYoutubeMention } from '../intel/alertEngine.js';
import { processMentionThroughStrategies } from '../intel/strategyEngine.js';
import { log } from '../logger.js';

let firstRun = true;
let running = false;

async function ingestBatch(videos, { seedOnly }) {
  let ingested = 0;
  let waiting = 0;
  for (const video of videos) {
    let result;
    try {
      result = await ingestVideo(video);
    } catch (err) {
      log.error('youtube', `Ingest failed for video ${video.id}: ${err.message}`);
      continue;
    }
    if (result.status === 'no_provider') {
      // Transcript providers disabled/unavailable — video waits, no retry burned.
      waiting++;
      continue;
    }
    ingested++;
    // On the very first poll everything looks "new" — ingest (data is the
    // moat) but don't fire alert rules for stale history.
    if (seedOnly || result.status !== 'ingested') continue;
    try {
      for (const mention of listAssetMentions({ videoId: video.id, limit: 500 })) {
        await dispatchYoutubeMention(mention, video);
        const alpha = mention.channel_id ? getCreatorAlpha(mention.channel_id)[0] ?? null : null;
        await processMentionThroughStrategies(mention, alpha);
      }
    } catch (err) {
      log.warn('youtube', `Mention dispatch failed for video ${video.id}: ${err.message}`);
    }
  }
  return { ingested, waiting };
}

export async function pollYoutubeChannels() {
  if (running) {
    log.warn('youtube', 'Previous poll still running — skipping this cycle');
    return;
  }
  running = true;
  try {
    const channels = listYoutubeChannels().filter((c) => c.tracking_enabled);
    for (const channel of channels) {
      try {
        await syncChannel(channel.id);
      } catch (err) {
        log.warn('youtube', `Channel sync failed for "${channel.title}": ${err.message}`);
      }
    }

    const live = listYoutubeVideosPendingIngestion({
      limit: config.influence.pollMaxVideosPerRun,
      maxAttempts: config.influence.transcriptMaxAttempts,
    });
    const liveDone = await ingestBatch(live, { seedOnly: firstRun });

    const backfill = listYoutubeVideosPendingIngestion({
      limit: config.influence.backfillMaxPerRun,
      maxAttempts: config.influence.transcriptMaxAttempts,
      backfill: true,
    });
    const backfillDone = await ingestBatch(backfill, { seedOnly: true }); // backfill is history — never alert

    const waiting = liveDone.waiting + backfillDone.waiting;
    log.info(
      'youtube',
      `Poll complete: ${channels.length} channels synced, ${liveDone.ingested}/${live.length} live and ` +
        `${backfillDone.ingested}/${backfill.length} backfill videos ingested` +
        `${waiting ? `, ${waiting} waiting on a transcript provider (auto transcripts ${config.influence.autoTranscriptsEnabled ? 'on' : 'OFF'})` : ''}` +
        `${firstRun ? ' (first run — seeded only, no alerts fired)' : ''}`
    );
    firstRun = false;
  } finally {
    running = false;
  }
}

export function startYoutubePoller() {
  log.info('youtube', `Starting YouTube poller (cron: ${config.polling.youtubeCron})`);
  (async () => {
    if (config.influence.rosterSeedEnabled) {
      try {
        const roster = loadYoutubeRoster(new URL('../lib/youtubeRoster.json', import.meta.url).pathname);
        if (roster.length) await seedYoutubeRoster(roster);
      } catch (err) {
        log.warn('youtube', `Roster seeding failed: ${err.message}`);
      }
    }
    await pollYoutubeChannels();
  })();
  return cron.schedule(config.polling.youtubeCron, pollYoutubeChannels);
}
