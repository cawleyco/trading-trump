import { config } from '../config.js';
import { hasSeenPost, markPostSeen, updateSeenPostClassification } from '../db.js';
import { makeTradeSignal } from '../signal.js';
import { processSignal } from '../riskManager.js';
import { classifyPost, isMarketRelevant } from '../sentiment/classifier.js';
import { buildCrossSignalContext } from '../intel/crossSignal.js';
import { fetchRecentPosts } from './truthSocialData.js';
import { log } from '../logger.js';

let firstRun = true;
let timer = null;

export async function pollTruthSocial() {
  let posts;
  try {
    posts = await fetchRecentPosts();
  } catch (err) {
    log.error('truth-social', `Failed to fetch posts: ${err.message}`);
    return;
  }

  const maxAgeMs = config.signals.sentimentMaxPostAgeMinutes * 60_000;

  for (const post of posts) {
    if (hasSeenPost(post.id)) continue;
    markPostSeen(post.id, post.text, post.createdAt);

    // Seed on first run — don't classify/trade the backlog at startup.
    if (firstRun) continue;

    const age = Date.now() - new Date(post.createdAt).getTime();
    if (age > maxAgeMs) {
      log.info('truth-social', `Skipping stale post ${post.id} (${Math.round(age / 60000)}m old)`);
      continue;
    }

    log.info('truth-social', `New post ${post.id}: "${post.text.slice(0, 120)}..."`);
    const classification = await classifyPost(post.text);
    if (!classification) continue;
    updateSeenPostClassification(post.id, classification);

    if (!isMarketRelevant(classification)) {
      log.info(
        'truth-social',
        `Post ${post.id} below market relevance gate (${classification.relevanceType}, ${classification.marketRelevance})`
      );
      continue;
    }

    if (classification.tickers.length === 0) {
      log.info(
        'truth-social',
        `Post ${post.id} is market-relevant but sector-only (${classification.sectors.join(', ') || 'no sectors'}); no v1 trade emitted`
      );
      continue;
    }

    // Confidence gating happens per fund in the risk manager (each fund can
    // set its own threshold) — emit every classified ticker.
    for (const t of classification.tickers) {
      try {
        const crossSignal = buildCrossSignalContext(post.id, { post, classification, ticker: t.ticker });
        const signal = makeTradeSignal({
          source: 'sentiment',
          ticker: t.ticker,
          direction: t.direction,
          confidence: t.confidence,
          rationale: `${t.rationale || classification.rationale} — post: "${post.text.slice(0, 200)}"`,
          rawReference: { postId: post.id, url: post.url, text: post.text, classification, crossSignal },
          eventTimestamp: post.createdAt,
        });
        await processSignal(signal);
      } catch (err) {
        log.error('truth-social', `Failed to process signal for ${t.ticker}: ${err.message}`);
      }
    }
  }

  if (firstRun) {
    log.info('truth-social', `First poll: seeded ${posts.length} existing posts, no trades placed`);
    firstRun = false;
  }
}

export function startTruthSocialPoller() {
  const intervalMs = config.polling.truthSocialSeconds * 1000;
  log.info('truth-social', `Starting Truth Social poller (every ${config.polling.truthSocialSeconds}s, watching @${config.polling.truthSocialUsername})`);
  pollTruthSocial();
  timer = setInterval(pollTruthSocial, intervalMs);
  return timer;
}

export function stopTruthSocialPoller() {
  if (timer) clearInterval(timer);
}
