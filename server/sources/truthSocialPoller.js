import { config } from '../config.js';
import { getSeenPost, markPostSeen, updateSeenPostClassification } from '../db.js';
import { makeTradeSignal } from '../signal.js';
import { processSignal } from '../riskManager.js';
import { classifyPost, isMarketRelevant } from '../sentiment/classifier.js';
import { buildCrossSignalContext } from '../intel/crossSignal.js';
import { dispatchPostClassified } from '../intel/alertEngine.js';
import { fetchRecentPosts } from './truthSocialData.js';
import { log } from '../logger.js';

let firstRun = true;
let timer = null;

export function planPostClassification({ post, seenPost, firstRun: isFirstRun, now = Date.now(), maxAgeMs }) {
  if (seenPost?.classification) {
    return { action: 'skip', reason: 'already-classified' };
  }

  const shouldTrade = !isFirstRun;
  const ageMs = now - new Date(post.createdAt).getTime();
  if (shouldTrade && ageMs > maxAgeMs) {
    return { action: 'skip', reason: 'stale', shouldTrade, ageMs };
  }

  return { action: 'classify', shouldTrade, ageMs };
}

export async function pollTruthSocial() {
  let posts;
  try {
    posts = await fetchRecentPosts();
  } catch (err) {
    log.error('truth-social', `Failed to fetch posts: ${err.message}`);
    return;
  }

  const maxAgeMs = config.signals.sentimentMaxPostAgeMinutes * 60_000;
  let seedClassified = 0;

  for (const post of posts) {
    let seenPost = getSeenPost(post.id);
    if (!seenPost || !seenPost.text || !seenPost.created_at) {
      markPostSeen(post.id, post.text, post.createdAt);
      seenPost = getSeenPost(post.id);
    }
    const plan = planPostClassification({ post, seenPost, firstRun, maxAgeMs });
    if (plan.action === 'skip') {
      if (plan.reason === 'stale') {
        log.info('truth-social', `Skipping stale post ${post.id} (${Math.round(plan.ageMs / 60000)}m old)`);
      }
      continue;
    }

    log.info(
      'truth-social',
      `${plan.shouldTrade ? 'New' : 'Seed'} post ${post.id}: "${post.text.slice(0, 120)}..."`
    );
    const classification = await classifyPost(post.text);
    if (!classification) continue;
    updateSeenPostClassification(post.id, classification);
    if (!plan.shouldTrade) {
      seedClassified += 1;
      continue;
    }

    // Fire alert rules for freshly-classified (non-seed) posts (deduped internally).
    dispatchPostClassified(post, classification);

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
    log.info('truth-social', `First poll: seeded ${posts.length} existing posts, classified ${seedClassified}, no trades placed`);
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
