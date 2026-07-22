import {
  createYoutubeBacktestRun,
  getYoutubeBacktestRun,
  insertYoutubeBacktestSignalResult,
  listAssetMentions,
  listLatestCreatorAlphaMetrics,
  listYoutubeChannels,
  replaceCreatorAlphaMetric,
  updateYoutubeBacktestRun,
} from '../db.js';
import { getDailyCloses, _firstCloseOnOrAfter } from '../marketData.js';
import { rawCreatorMetrics, percentileAlphaScores, labelCreator } from '../influence/creatorStats.js';
import { log } from '../logger.js';

const WINDOWS = {
  '1h': 1 / 24,
  '6h': 6 / 24,
  '24h': 1,
  '7d': 7,
  '30d': 30,
  '90d': 90,
};

const DAY_MS = 86400_000;
// A minute/daily bar must exist within this span after the target time to
// count as a fill — otherwise the market was closed and the window is null.
const MINUTE_FILL_TOLERANCE_MS = 30 * 60_000;
const BENCHMARK_SYMBOL = 'SPY';
// Grayscale Bitcoin Mini Trust trades under ticker BTC on the same equity feed
// used for crypto entry/exit proxies, so it needs no separate data path.
const CRYPTO_BENCHMARK_SYMBOL = 'BTC';

export function benchmarkSymbolFor(assetType) {
  return assetType === 'crypto' ? CRYPTO_BENCHMARK_SYMBOL : BENCHMARK_SYMBOL;
}

// ---------------------------------------------------------------------------
// Real market data provider. Injectable so tests stay offline (ground rule:
// unit tests never hit the network). Both methods return null on any failure —
// a missing price must never abort a whole backtest run.
// ---------------------------------------------------------------------------

export const alpacaPriceProvider = {
  async minuteBars(symbol, startIso, endIso) {
    try {
      const { getMinuteBarsCached } = await import('../marketData.js');
      return await getMinuteBarsCached(symbol, startIso, endIso);
    } catch (err) {
      log.warn('youtube-backtest', `minute bars ${symbol} failed: ${err.message}`);
      return null;
    }
  },
  // Persistently cached and null-safe already.
  dailyCloses: getDailyCloses,
};

export function calculateDirectionalReturn(direction, entry, exit) {
  if (!entry || !exit) return null;
  if (direction === 'bearish') return ((entry - exit) / entry) * 100;
  return ((exit - entry) / entry) * 100;
}

// Raw, un-flipped price move (%). Directional return answers "was the creator
// right"; this answers "which way did the asset actually move" — the input to
// an abnormal-return (market-impact) measure.
export function calculateRawReturn(entry, exit) {
  if (!entry || !exit) return null;
  return ((exit - entry) / entry) * 100;
}

export function sampleWarning(sampleSize) {
  if (sampleSize < 5) return `Only ${sampleSize} historical mentions match this strategy. Results are unreliable.`;
  if (sampleSize < 20) return `Small sample size (${sampleSize} mentions). Treat results as directional only.`;
  return null;
}

function isoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Entry price for a mention. Prefers the first minute bar at/after the mention
 * time (within tolerance). When the market was closed (evening/weekend upload)
 * or minute data is unavailable, falls back to the next trading day's open —
 * strictly after the mention date, so a post-close mention can never enter at
 * a price printed before it happened.
 */
export function _entryPrice({ minuteBars, dailyBars, eventMs }) {
  const bar = (minuteBars || []).find((b) => {
    const t = new Date(b.timestamp).getTime();
    return t >= eventMs && t <= eventMs + MINUTE_FILL_TOLERANCE_MS;
  });
  if (bar && (bar.open ?? bar.close) != null) {
    return { price: bar.open ?? bar.close, source: 'minute' };
  }
  const eventDate = isoDate(eventMs);
  const daily = (dailyBars || []).find((b) => b.date > eventDate && (b.open ?? b.close) != null);
  if (daily) return { price: daily.open ?? daily.close, source: 'daily-open' };
  return { price: null, source: null };
}

/**
 * Exit price `windowDays` after the mention. Intraday windows (< 1 day) need a
 * minute-bar entry — measuring a "1h move" from a next-day-open entry would be
 * fiction, so those return null. Daily windows use the first close on/after
 * the target date (a window ending on a weekend exits at Monday's close).
 */
export function _exitPrice({ minuteBars, dailyBars, eventMs, windowDays, entrySource }) {
  if (windowDays < 1) {
    if (entrySource !== 'minute') return null;
    const target = eventMs + windowDays * DAY_MS;
    const bar = (minuteBars || []).find((b) => {
      const t = new Date(b.timestamp).getTime();
      return t >= target && t <= target + MINUTE_FILL_TOLERANCE_MS;
    });
    return bar ? bar.close ?? bar.open ?? null : null;
  }
  return _firstCloseOnOrAfter(dailyBars, isoDate(eventMs + windowDays * DAY_MS));
}

/** Median with even-length averaging (upper-middle alone overstates skewed returns). */
export function _median(vals) {
  const usable = vals.filter((v) => typeof v === 'number').sort((a, b) => a - b);
  if (!usable.length) return null;
  const mid = Math.floor(usable.length / 2);
  return usable.length % 2 ? usable[mid] : (usable[mid - 1] + usable[mid]) / 2;
}

/** Pure result builder — all price series are passed in. */
export function _resultForMention(mention, exitWindows, { minuteBars, dailyBars, benchmarkBars }) {
  const eventMs = new Date(mention.event_time).getTime();
  const { price: entryPrice, source: entrySource } = _entryPrice({ minuteBars, dailyBars, eventMs });
  const out = {
    mention_id: mention.id,
    asset_id: mention.asset_id,
    entry_time: mention.event_time,
    entry_price: entryPrice,
    result_metadata: {
      channelTitle: mention.channel_title,
      videoTitle: mention.video_title,
      direction: mention.direction,
      mentionQualityScore: mention.mention_quality_score,
      priceSource: entrySource,
      noPriceData: entryPrice == null,
      benchmarkSymbol: benchmarkSymbolFor(mention.asset_type),
    },
  };
  // Window-matched benchmark drift (SPY for equities, BTC for crypto), from
  // daily closes. Sub-day windows
  // land inside one trading day, so the daily benchmark is ~0 and abnormal
  // collapses to raw — honest, since intraday SPY isn't loaded here.
  const benchmarkReturn = (days) => {
    if (entryPrice == null || !benchmarkBars) return null;
    const from = _firstCloseOnOrAfter(benchmarkBars, isoDate(eventMs));
    const to = _firstCloseOnOrAfter(benchmarkBars, isoDate(eventMs + days * DAY_MS));
    return from && to ? ((to - from) / from) * 100 : null;
  };
  for (const window of exitWindows) {
    const days = WINDOWS[window];
    if (!days) continue;
    const price = entryPrice == null
      ? null
      : _exitPrice({ minuteBars, dailyBars, eventMs, windowDays: days, entrySource });
    const raw = calculateRawReturn(entryPrice, price);
    const bench = benchmarkReturn(days);
    out[`exit_${window}_price`] = price;
    // `return_*` stays directional (creator-correctness) for backward compat.
    out[`return_${window}`] = calculateDirectionalReturn(mention.direction, entryPrice, price);
    out[`raw_return_${window}`] = raw;
    out[`benchmark_return_${window}`] = bench;
    out[`abnormal_return_${window}`] = raw != null && bench != null ? raw - bench : null;
  }
  // Approximation from window returns, not the true intra-window path.
  out.max_drawdown_30d = Math.min(0, out.return_30d ?? out.return_7d ?? 0);
  out.max_runup_30d = Math.max(0, out.return_30d ?? out.return_7d ?? 0);
  // Kept as a named column (persisted by insertYoutubeBacktestSignalResult).
  out.benchmark_return_30d = out.benchmark_return_30d ?? benchmarkReturn(30);
  return out;
}

function summarize(results) {
  const priced = results.filter((r) => r.entry_price != null);
  const byWindow = {};
  for (const window of Object.keys(WINDOWS)) {
    const key = `return_${window}`;
    const vals = results.map((r) => r[key]).filter((v) => typeof v === 'number');
    byWindow[window] = vals.length
      ? {
          averageReturn: vals.reduce((a, b) => a + b, 0) / vals.length,
          winRate: vals.filter((v) => v > 0).length / vals.length,
          sampleSize: vals.length,
        }
      : { averageReturn: null, winRate: null, sampleSize: 0 };
  }
  return {
    sampleSize: results.length,
    priced: priced.length,
    noPriceData: results.length - priced.length,
    warning: sampleWarning(priced.length),
    byWindow,
  };
}

// ---------------------------------------------------------------------------
// Series loading. One minute-bar fetch per (symbol, event-hour) covers entry
// + 1h + 6h; daily closes are fetched once per symbol spanning every mention
// in the run; the SPY benchmark series is fetched once per run.
// ---------------------------------------------------------------------------

const maxWindowDays = (exitWindows) =>
  Math.max(1, ...exitWindows.map((w) => WINDOWS[w] ?? 0));

function needsMinutes(exitWindows) {
  return exitWindows.some((w) => WINDOWS[w] < 1);
}

async function loadSeries(mentions, exitWindows, provider) {
  const spanDays = maxWindowDays(exitWindows);
  const bySymbol = new Map();
  for (const m of mentions) {
    const ms = new Date(m.event_time).getTime();
    const cur = bySymbol.get(m.symbol) || { min: ms, max: ms };
    cur.min = Math.min(cur.min, ms);
    cur.max = Math.max(cur.max, ms);
    bySymbol.set(m.symbol, cur);
  }

  const daily = new Map();
  for (const [symbol, { min, max }] of bySymbol) {
    daily.set(symbol, await provider.dailyCloses(symbol, isoDate(min - DAY_MS), isoDate(max + (spanDays + 14) * DAY_MS)));
  }

  // Benchmark per asset class: equities vs SPY, crypto vs a bitcoin proxy.
  // Subtracting SPY from a crypto move leaves crypto-vs-equity beta in the
  // "abnormal" number, so crypto is benchmarked against BTC instead.
  const benchmarks = new Map();
  if (bySymbol.size) {
    const allMin = Math.min(...[...bySymbol.values()].map((s) => s.min));
    const allMax = Math.max(...[...bySymbol.values()].map((s) => s.max));
    const wantedBenchmarks = new Set(mentions.map((m) => benchmarkSymbolFor(m.asset_type)));
    for (const symbol of wantedBenchmarks) {
      benchmarks.set(
        symbol,
        await provider.dailyCloses(symbol, isoDate(allMin - DAY_MS), isoDate(allMax + 44 * DAY_MS))
      );
    }
  }
  const benchmarkFor = (mention) => benchmarks.get(benchmarkSymbolFor(mention.asset_type)) ?? null;

  const minuteCache = new Map();
  const wantMinutes = needsMinutes(exitWindows);
  const minutesFor = async (mention) => {
    const ms = new Date(mention.event_time).getTime();
    const key = `${mention.symbol}|${Math.floor(ms / 3600_000)}`;
    if (!minuteCache.has(key)) {
      const end = new Date(ms + (wantMinutes ? 6 * 3600_000 : 0) + 2 * MINUTE_FILL_TOLERANCE_MS).toISOString();
      minuteCache.set(key, await provider.minuteBars(mention.symbol, new Date(ms).toISOString(), end));
    }
    return minuteCache.get(key);
  };

  return { daily, benchmarkFor, minutesFor };
}

export async function runYoutubeBacktest(config = {}, { provider = alpacaPriceProvider } = {}) {
  const exitWindows = (config.exitWindows?.length ? config.exitWindows : ['1h', '24h', '7d', '30d'])
    .filter((w) => WINDOWS[w]);
  const allMentions = listAssetMentions({
    videoId: config.videoId,
    channelId: config.channelId,
    assetId: config.assetId,
    limit: config.limit || 1000,
  });
  // Funnel counts explain small samples: most mentions drop out because they
  // were never classified with a direction, not because prices are missing.
  const withDirection = allMentions.filter((m) => ['bullish', 'bearish'].includes(m.direction));
  const mentions = withDirection.filter((m) => {
    if (config.mentionId && Number(m.id) !== Number(config.mentionId)) return false;
    if (config.directions?.length && !config.directions.includes(m.direction)) return false;
    if (config.mentionTypes?.length && !config.mentionTypes.includes(m.mention_type)) return false;
    if (config.minMentionQualityScore && Number(m.mention_quality_score || 0) < config.minMentionQualityScore) return false;
    if (config.minEntityConfidence && Number(m.entity_confidence || 0) < config.minEntityConfidence) return false;
    return true;
  });
  const funnel = {
    mentionsTotal: allMentions.length,
    withDirection: withDirection.length,
    afterQualityFilters: mentions.length,
  };
  const runId = createYoutubeBacktestRun({
    name: config.name || 'YouTube mention backtest',
    strategy_config: config,
    start_date: config.startDate ?? null,
    end_date: config.endDate ?? null,
    status: 'running',
  });
  try {
    const { daily, benchmarkFor, minutesFor } = await loadSeries(mentions, exitWindows, provider);
    const results = [];
    for (const mention of mentions) {
      results.push(
        _resultForMention(mention, exitWindows, {
          minuteBars: await minutesFor(mention),
          dailyBars: daily.get(mention.symbol),
          benchmarkBars: benchmarkFor(mention),
        })
      );
    }
    for (const result of results) {
      insertYoutubeBacktestSignalResult({ ...result, backtest_run_id: runId });
    }
    updateYoutubeBacktestRun(runId, { status: 'complete', completed_at: new Date().toISOString() });
    return { ...getYoutubeBacktestRun(runId), summary: { ...summarize(results), funnel } };
  } catch (err) {
    updateYoutubeBacktestRun(runId, { status: 'failed', completed_at: new Date().toISOString() });
    throw err;
  }
}

// Price a set of mentions across the given windows. Shared by creator-alpha
// refresh and the walk-forward validator.
export async function priceMentions(mentions, windows, provider = alpacaPriceProvider) {
  const { daily, benchmarkFor, minutesFor } = await loadSeries(mentions, windows, provider);
  const results = [];
  for (const mention of mentions) {
    results.push(
      _resultForMention(mention, windows, {
        minuteBars: await minutesFor(mention),
        dailyBars: daily.get(mention.symbol),
        benchmarkBars: benchmarkFor(mention),
      })
    );
  }
  return results;
}

const ALPHA_WINDOWS = ['1h', '6h', '24h', '7d', '30d', '90d'];

function directionalMentions(channelId) {
  return listAssetMentions({ channelId, limit: 5000 }).filter((m) =>
    ['bullish', 'bearish'].includes(m.direction)
  );
}

function storeCreatorAlpha(channelId, metrics, alphaScore) {
  const policy = labelCreator({
    measurable: metrics.measurable_mentions,
    avgReturn30d: metrics.avg_return_30d,
    alphaScore,
    pumpDumpRate: metrics.pump_dump_rate,
    pdMeasurable: metrics.pd_measurable,
  });
  const { pd_measurable, ...columns } = metrics;
  replaceCreatorAlphaMetric({
    channel_id: channelId,
    ...columns,
    alpha_score: policy.alpha_score,
    fade_score: policy.fade_score,
    label: policy.label,
    alpha_basis: policy.alpha_basis,
  });
  return {
    channelId,
    sampleSize: metrics.sample_size,
    measurable: metrics.measurable_mentions,
    alphaScore: policy.alpha_score,
    label: policy.label,
  };
}

/**
 * Recompute one creator's alpha. The percentile is taken against the latest
 * stored metrics of the other creators (slightly stale by design); the
 * nightly refreshAllCreatorAlpha() recomputes the whole universe fresh.
 */
export async function recalculateCreatorAlpha(channelId, { provider = alpacaPriceProvider } = {}) {
  const results = await priceMentions(directionalMentions(channelId), ALPHA_WINDOWS, provider);
  const metrics = rawCreatorMetrics(results);
  const universe = listLatestCreatorAlphaMetrics()
    .filter((row) => row.channel_id !== channelId)
    .map((row) => ({
      channelId: row.channel_id,
      measurable: row.measurable_mentions ?? 0,
      avgReturn30d: row.avg_return_30d,
    }));
  universe.push({
    channelId,
    measurable: metrics.measurable_mentions,
    avgReturn30d: metrics.avg_return_30d,
  });
  const alphaScore = percentileAlphaScores(universe).get(channelId) ?? null;
  return storeCreatorAlpha(channelId, metrics, alphaScore);
}

/** Nightly refresh: recompute every tracked creator, then percentile-rank the fresh universe. */
export async function refreshAllCreatorAlpha({ provider = alpacaPriceProvider } = {}) {
  const channels = listYoutubeChannels().filter((c) => c.tracking_enabled);
  const computed = [];
  for (const channel of channels) {
    try {
      const results = await priceMentions(directionalMentions(channel.id), ALPHA_WINDOWS, provider);
      computed.push({ channelId: channel.id, metrics: rawCreatorMetrics(results) });
    } catch (err) {
      log.warn('youtube-backtest', `Creator alpha failed for "${channel.title}": ${err.message}`);
    }
  }
  const scores = percentileAlphaScores(
    computed.map((c) => ({
      channelId: c.channelId,
      measurable: c.metrics.measurable_mentions,
      avgReturn30d: c.metrics.avg_return_30d,
    }))
  );
  const summary = computed.map((c) =>
    storeCreatorAlpha(c.channelId, c.metrics, scores.get(c.channelId) ?? null)
  );
  log.info(
    'youtube-backtest',
    `Creator alpha refresh: ${summary.length} channels, ` +
      `${summary.filter((s) => s.label === 'follow').length} follow, ` +
      `${summary.filter((s) => s.label === 'fade').length} fade, ` +
      `${summary.filter((s) => s.label === 'insufficient_data').length} insufficient data`
  );
  return summary;
}
