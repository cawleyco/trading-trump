import {
  createYoutubeBacktestRun,
  getYoutubeBacktestRun,
  insertYoutubeBacktestSignalResult,
  listAssetMentions,
  replaceCreatorAlphaMetric,
  updateYoutubeBacktestRun,
} from '../db.js';
import { getDailyCloses, _firstCloseOnOrAfter } from '../marketData.js';
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

function avg(vals) {
  const usable = vals.filter((v) => typeof v === 'number');
  return usable.length ? usable.reduce((a, b) => a + b, 0) / usable.length : null;
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
    },
  };
  for (const window of exitWindows) {
    const days = WINDOWS[window];
    if (!days) continue;
    const price = entryPrice == null
      ? null
      : _exitPrice({ minuteBars, dailyBars, eventMs, windowDays: days, entrySource });
    out[`exit_${window}_price`] = price;
    out[`return_${window}`] = calculateDirectionalReturn(mention.direction, entryPrice, price);
  }
  // Approximation from window returns, not the true intra-window path.
  out.max_drawdown_30d = Math.min(0, out.return_30d ?? out.return_7d ?? 0);
  out.max_runup_30d = Math.max(0, out.return_30d ?? out.return_7d ?? 0);
  if (entryPrice != null && benchmarkBars) {
    const from = _firstCloseOnOrAfter(benchmarkBars, isoDate(eventMs));
    const to = _firstCloseOnOrAfter(benchmarkBars, isoDate(eventMs + 30 * DAY_MS));
    out.benchmark_return_30d = from && to ? ((to - from) / from) * 100 : null;
  } else {
    out.benchmark_return_30d = null;
  }
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

  let benchmark = null;
  if (bySymbol.size) {
    const allMin = Math.min(...[...bySymbol.values()].map((s) => s.min));
    const allMax = Math.max(...[...bySymbol.values()].map((s) => s.max));
    benchmark = await provider.dailyCloses(BENCHMARK_SYMBOL, isoDate(allMin - DAY_MS), isoDate(allMax + 44 * DAY_MS));
  }

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

  return { daily, benchmark, minutesFor };
}

export async function runYoutubeBacktest(config = {}, { provider = alpacaPriceProvider } = {}) {
  const exitWindows = (config.exitWindows?.length ? config.exitWindows : ['1h', '24h', '7d', '30d'])
    .filter((w) => WINDOWS[w]);
  const mentions = listAssetMentions({
    videoId: config.videoId,
    channelId: config.channelId,
    assetId: config.assetId,
    limit: config.limit || 1000,
  }).filter((m) => {
    if (config.mentionId && Number(m.id) !== Number(config.mentionId)) return false;
    if (config.directions?.length && !config.directions.includes(m.direction)) return false;
    if (config.mentionTypes?.length && !config.mentionTypes.includes(m.mention_type)) return false;
    if (config.minMentionQualityScore && Number(m.mention_quality_score || 0) < config.minMentionQualityScore) return false;
    if (config.minEntityConfidence && Number(m.entity_confidence || 0) < config.minEntityConfidence) return false;
    return !!m.direction && ['bullish', 'bearish'].includes(m.direction);
  });
  const runId = createYoutubeBacktestRun({
    name: config.name || 'YouTube mention backtest',
    strategy_config: config,
    start_date: config.startDate ?? null,
    end_date: config.endDate ?? null,
    status: 'running',
  });
  try {
    const { daily, benchmark, minutesFor } = await loadSeries(mentions, exitWindows, provider);
    const results = [];
    for (const mention of mentions) {
      results.push(
        _resultForMention(mention, exitWindows, {
          minuteBars: await minutesFor(mention),
          dailyBars: daily.get(mention.symbol),
          benchmarkBars: benchmark,
        })
      );
    }
    for (const result of results) {
      insertYoutubeBacktestSignalResult({ ...result, backtest_run_id: runId });
    }
    updateYoutubeBacktestRun(runId, { status: 'complete', completed_at: new Date().toISOString() });
    return { ...getYoutubeBacktestRun(runId), summary: summarize(results) };
  } catch (err) {
    updateYoutubeBacktestRun(runId, { status: 'failed', completed_at: new Date().toISOString() });
    throw err;
  }
}

export async function recalculateCreatorAlpha(channelId, { provider = alpacaPriceProvider } = {}) {
  const mentions = listAssetMentions({ channelId, limit: 5000 }).filter((m) => ['bullish', 'bearish'].includes(m.direction));
  const windows = ['1h', '6h', '24h', '7d', '30d', '90d'];
  const { daily, benchmark, minutesFor } = await loadSeries(mentions, windows, provider);
  const results = [];
  for (const mention of mentions) {
    results.push(
      _resultForMention(mention, windows, {
        minuteBars: await minutesFor(mention),
        dailyBars: daily.get(mention.symbol),
        benchmarkBars: benchmark,
      })
    );
  }
  const sampleSize = results.length;
  // Rates are computed over mentions with real price data for that window —
  // counting a data gap as a loss would penalize thin tickers, not bad calls.
  const measurable30 = results.filter((r) => typeof r.return_30d === 'number');
  const avg30 = avg(results.map((r) => r.return_30d));
  const win30 = measurable30.length
    ? measurable30.filter((r) => r.return_30d > 0).length / measurable30.length
    : null;
  const winRateOver = (key) => {
    const usable = results.filter((r) => typeof r[key] === 'number');
    return usable.length ? usable.filter((r) => r[key] > 0).length / usable.length : null;
  };
  const pdMeasurable = results.filter(
    (r) => typeof r.return_24h === 'number' && typeof r.return_7d === 'number'
  );
  const pumpDumpRate = pdMeasurable.length
    ? pdMeasurable.filter((r) => r.return_24h > 5 && r.return_7d < -5).length / pdMeasurable.length
    : null;
  const alphaScore = measurable30.length < 3
    ? 0
    : Math.max(0, Math.min(100, 50 + (avg30 ?? 0) * 3 + (win30 ?? 0) * 25 - (pumpDumpRate ?? 0) * 30));
  const label = measurable30.length < 5
    ? 'Insufficient Data'
    : pumpDumpRate > 0.35
      ? 'High Pump Risk'
      : alphaScore >= 75
        ? 'High Alpha Creator'
        : alphaScore < 40
          ? 'Mostly Noise'
          : 'Medium Confidence';
  replaceCreatorAlphaMetric({
    channel_id: channelId,
    sample_size: sampleSize,
    avg_return_1h: avg(results.map((r) => r.return_1h)),
    avg_return_6h: avg(results.map((r) => r.return_6h)),
    avg_return_24h: avg(results.map((r) => r.return_24h)),
    avg_return_7d: avg(results.map((r) => r.return_7d)),
    avg_return_30d: avg30,
    avg_return_90d: avg(results.map((r) => r.return_90d)),
    win_rate_24h: winRateOver('return_24h'),
    win_rate_7d: winRateOver('return_7d'),
    win_rate_30d: win30,
    median_return_30d: _median(results.map((r) => r.return_30d)),
    pump_dump_rate: pumpDumpRate,
    fade_score: alphaScore < 40 ? 100 - alphaScore : 0,
    alpha_score: alphaScore,
    label,
  });
  return { sampleSize, measurable: measurable30.length, alphaScore, label };
}
