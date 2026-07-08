import axios from 'axios';
import { classifyPost } from '../sentiment/classifier.js';
import { simulateTrades } from './simulate.js';
import { insertBacktest, listSeenPosts } from '../db.js';
import { config } from '../config.js';
import { log } from '../logger.js';

// Historical Trump post archive (auto-updated public dataset)
const ARCHIVE_URL =
  'https://raw.githubusercontent.com/stiles/trump-truth-social-archive/main/data/truth_archive.json';

let archiveCache = { data: null, fetchedAt: 0 };

function stripHtml(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .trim();
}

export async function getArchivePosts() {
  if (archiveCache.data && Date.now() - archiveCache.fetchedAt < 3600_000) {
    return archiveCache.data;
  }
  log.info('backtest', 'Fetching Trump post archive (~15MB, cached for 1h)...');
  const resp = await axios.get(ARCHIVE_URL, { timeout: 120000, maxContentLength: 100_000_000 });
  const byId = new Map();
  for (const p of Array.isArray(resp.data) ? resp.data : []) {
    const text = stripHtml(p.content);
    if (text.length > 0) byId.set(String(p.id), { id: String(p.id), text, createdAt: p.created_at });
  }
  // The public archive lags/can go stale — supplement with posts the live
  // poller has collected itself, so recent dates stay backtestable.
  for (const row of listSeenPosts()) {
    if (!byId.has(row.post_id)) {
      byId.set(row.post_id, { id: row.post_id, text: row.text, createdAt: row.created_at });
    }
  }
  const posts = [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  archiveCache = { data: posts, fetchedAt: Date.now() };
  return posts;
}

/**
 * "If I had traded every market-relevant Trump post from {startDate} to
 *  {endDate} with ${notionalPerTrade} per trade, exiting after {holdDays}
 *  days, what would my P&L be?"
 *
 * Each post in range is run through the same Claude classifier used live;
 * tickers above the confidence threshold become simulated trades entered at
 * the first market open after the post.
 *
 * maxPosts caps classification volume (each post = one Claude call).
 */
export async function runTweetBacktest({
  startDate,
  endDate,
  notionalPerTrade,
  holdDays = 1,
  holdHours = null,
  confidenceThreshold,
  maxPosts = 200,
  stopLossPct = null,
  takeProfitPct = null,
}) {
  const threshold = confidenceThreshold ?? config.signals.sentimentConfidenceThreshold;
  const all = await getArchivePosts();
  const inRange = all.filter(
    (p) => p.createdAt.slice(0, 10) >= startDate && p.createdAt.slice(0, 10) <= endDate
  );
  // Sample with an even stride across the whole range — a plain slice would
  // test only the oldest maxPosts posts and silently ignore the rest.
  let posts = inRange;
  if (inRange.length > maxPosts) {
    const step = inRange.length / maxPosts;
    posts = Array.from({ length: maxPosts }, (_, i) => inRange[Math.floor(i * step)]);
  }
  log.info('backtest', `Tweet backtest: classifying ${posts.length} of ${inRange.length} posts in range (cap ${maxPosts})`);

  const plans = [];
  const classifications = [];
  for (const post of posts) {
    const classification = await classifyPost(post.text);
    if (!classification) continue;
    const tickers = classification.tickers.map((t) => ({
      ticker: String(t.ticker).toUpperCase(),
      direction: t.direction,
      confidence: t.confidence,
      traded: t.confidence >= threshold,
    }));
    classifications.push({
      postId: post.id,
      createdAt: post.createdAt,
      text: post.text.slice(0, 200),
      rationale: classification.rationale,
      tickers,
    });
    for (const t of tickers) {
      if (!t.traded) continue;
      plans.push({
        ticker: t.ticker,
        direction: t.direction,
        entryDate: post.createdAt.slice(0, 10),
        // holdHours triggers minute-bar simulation entering right after the post
        entryTimestamp: holdHours != null ? post.createdAt : null,
        exitDate: null,
        holdDays: holdHours != null ? null : holdDays,
        holdHours,
        stopLossPct,
        takeProfitPct,
        label: `${t.direction} ${t.ticker} @ ${t.confidence} — "${post.text.slice(0, 80)}"`,
        meta: { postId: post.id, confidence: t.confidence, rationale: classification.rationale },
      });
    }
  }

  const results = await simulateTrades(plans, notionalPerTrade);
  results.postsInRange = inRange.length;
  results.postsScanned = posts.length;
  results.classifiedPosts = classifications.length;
  results.noImpactPosts = classifications.filter((c) => c.tickers.length === 0).length;
  results.belowThresholdTickers = classifications.reduce(
    (n, c) => n + c.tickers.filter((t) => !t.traded).length, 0);
  results.classifications = classifications;
  results.archiveCoverage = all.length
    ? { from: all[0].createdAt.slice(0, 10), to: all[all.length - 1].createdAt.slice(0, 10) }
    : null;
  if (posts.length > 0 && classifications.length === 0) {
    results.warning =
      'The classifier returned nothing for every post — check ANTHROPIC_API_KEY and SENTIMENT_MODEL, then check the server log for sentiment errors.';
  } else if (inRange.length === 0 && all.length > 0) {
    results.warning =
      `No posts found between ${startDate} and ${endDate}. Available post data covers ` +
      `${results.archiveCoverage.from} to ${results.archiveCoverage.to} — the public archive can lag; ` +
      'the bot also collects new posts itself while running, extending coverage forward.';
  }
  results.fellBackToDaily = results.trades.filter((t) => t.fellBackToDaily).length;
  const params = { startDate, endDate, notionalPerTrade, holdDays, holdHours, confidenceThreshold: threshold, maxPosts, stopLossPct, takeProfitPct };
  const id = insertBacktest({ kind: 'tweet', params, results });
  return { id, params, results };
}
