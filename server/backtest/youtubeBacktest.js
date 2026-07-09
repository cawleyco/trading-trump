import {
  createYoutubeBacktestRun,
  getYoutubeBacktestRun,
  insertYoutubeBacktestSignalResult,
  listAssetMentions,
  replaceCreatorAlphaMetric,
  updateYoutubeBacktestRun,
} from '../db.js';

const WINDOWS = {
  '1h': 1 / 24,
  '6h': 6 / 24,
  '24h': 1,
  '7d': 7,
  '30d': 30,
  '90d': 90,
};

function hashNumber(seed) {
  let h = 2166136261;
  for (const ch of String(seed)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h >>> 0);
}

function mockPrice(assetSymbol, iso, offsetDays = 0) {
  const base = 50 + (hashNumber(assetSymbol) % 350);
  const wave = Math.sin((new Date(iso).getTime() / 86400000 + offsetDays + hashNumber(assetSymbol) % 31) / 7);
  return Number((base * (1 + wave * 0.08 + offsetDays * 0.002)).toFixed(2));
}

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

function summarize(results) {
  const byWindow = {};
  for (const window of Object.keys(WINDOWS)) {
    const key = `return_${window}`;
    const vals = results.map((r) => r[key]).filter((v) => typeof v === 'number');
    byWindow[window] = vals.length
      ? {
          averageReturn: vals.reduce((a, b) => a + b, 0) / vals.length,
          winRate: vals.filter((v) => v > 0).length / vals.length,
        }
      : { averageReturn: null, winRate: null };
  }
  return {
    sampleSize: results.length,
    warning: sampleWarning(results.length),
    byWindow,
  };
}

function resultForMention(mention, exitWindows) {
  const entryTime = mention.event_time;
  const entryPrice = mockPrice(mention.symbol, entryTime, 0);
  const out = {
    mention_id: mention.id,
    asset_id: mention.asset_id,
    entry_time: entryTime,
    entry_price: entryPrice,
    result_metadata: {
      channelTitle: mention.channel_title,
      videoTitle: mention.video_title,
      direction: mention.direction,
      mentionQualityScore: mention.mention_quality_score,
      mockMarketData: true,
    },
  };
  for (const window of exitWindows) {
    const days = WINDOWS[window];
    if (!days) continue;
    const price = mockPrice(mention.symbol, entryTime, days);
    out[`exit_${window}_price`] = price;
    out[`return_${window}`] = calculateDirectionalReturn(mention.direction, entryPrice, price);
  }
  out.max_drawdown_30d = Math.min(0, out.return_30d ?? out.return_7d ?? 0);
  out.max_runup_30d = Math.max(0, out.return_30d ?? out.return_7d ?? 0);
  out.benchmark_return_30d = 0;
  return out;
}

export function runYoutubeBacktest(config = {}) {
  const exitWindows = (config.exitWindows?.length ? config.exitWindows : ['1h', '24h', '7d', '30d'])
    .filter((w) => WINDOWS[w]);
  const mentions = listAssetMentions({
    channelId: config.channelId,
    assetId: config.assetId,
    limit: config.limit || 1000,
  }).filter((m) => {
    if (config.videoId && Number(m.video_id) !== Number(config.videoId)) return false;
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
  const results = mentions.map((m) => resultForMention(m, exitWindows));
  for (const result of results) {
    insertYoutubeBacktestSignalResult({ ...result, backtest_run_id: runId });
  }
  updateYoutubeBacktestRun(runId, { status: 'complete', completed_at: new Date().toISOString() });
  return { ...getYoutubeBacktestRun(runId), summary: summarize(results) };
}

function avg(vals) {
  const usable = vals.filter((v) => typeof v === 'number');
  return usable.length ? usable.reduce((a, b) => a + b, 0) / usable.length : null;
}

function median(vals) {
  const usable = vals.filter((v) => typeof v === 'number').sort((a, b) => a - b);
  if (!usable.length) return null;
  return usable[Math.floor(usable.length / 2)];
}

export function recalculateCreatorAlpha(channelId) {
  const mentions = listAssetMentions({ channelId, limit: 5000 }).filter((m) => ['bullish', 'bearish'].includes(m.direction));
  const synthetic = mentions.map((m) => resultForMention(m, ['1h', '6h', '24h', '7d', '30d', '90d']));
  const sampleSize = synthetic.length;
  const avg30 = avg(synthetic.map((r) => r.return_30d));
  const win30 = sampleSize ? synthetic.filter((r) => (r.return_30d ?? 0) > 0).length / sampleSize : null;
  const pumpDumpRate = sampleSize
    ? synthetic.filter((r) => (r.return_24h ?? 0) > 5 && (r.return_7d ?? 0) < -5).length / sampleSize
    : null;
  const alphaScore = sampleSize < 3
    ? 0
    : Math.max(0, Math.min(100, 50 + (avg30 ?? 0) * 3 + (win30 ?? 0) * 25 - (pumpDumpRate ?? 0) * 30));
  const label = sampleSize < 5
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
    avg_return_1h: avg(synthetic.map((r) => r.return_1h)),
    avg_return_6h: avg(synthetic.map((r) => r.return_6h)),
    avg_return_24h: avg(synthetic.map((r) => r.return_24h)),
    avg_return_7d: avg(synthetic.map((r) => r.return_7d)),
    avg_return_30d: avg30,
    avg_return_90d: avg(synthetic.map((r) => r.return_90d)),
    win_rate_24h: sampleSize ? synthetic.filter((r) => (r.return_24h ?? 0) > 0).length / sampleSize : null,
    win_rate_7d: sampleSize ? synthetic.filter((r) => (r.return_7d ?? 0) > 0).length / sampleSize : null,
    win_rate_30d: win30,
    median_return_30d: median(synthetic.map((r) => r.return_30d)),
    pump_dump_rate: pumpDumpRate,
    fade_score: alphaScore < 40 ? 100 - alphaScore : 0,
    alpha_score: alphaScore,
    label,
  });
  return { sampleSize, alphaScore, label };
}
