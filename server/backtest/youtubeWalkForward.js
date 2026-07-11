// Walk-forward validation for creator signals: the overfitting guard before
// any YouTube mention is allowed to influence real money. Rank creators by
// mention returns in each in-sample window, then measure only the top-N's
// mentions in the *next* window (out of sample). A creator who looks brilliant
// in-sample and flops out-of-sample is noise, not edge — same reasoning as
// the congress walk-forward (walkForward.js), reusing its splitWindows.
import { createYoutubeBacktestRun, getYoutubeBacktestRun, listAssetMentions, updateYoutubeBacktestRun } from '../db.js';
import { splitWindows } from './walkForward.js';
import { priceMentions, alpacaPriceProvider } from './youtubeBacktest.js';

const HORIZONS = ['24h', '7d', '30d'];

function avg(vals) {
  const usable = vals.filter((v) => typeof v === 'number');
  return usable.length ? usable.reduce((a, b) => a + b, 0) / usable.length : null;
}

function inWindow(mention, window) {
  const day = String(mention.event_time || '').slice(0, 10);
  return day >= window.start && day <= window.end;
}

/**
 * Pure fold assembly over already-priced mention results. Exported for tests.
 * results: _resultForMention rows augmented with channel_id/channel_title
 * (carried through result_metadata is not enough — we attach them below).
 */
export function assembleFolds(pricedMentions, windows, { topN, minMentions, returnKey }) {
  const foldResults = [];
  const combinedReturns = [];
  for (let i = 0; i < windows.length - 1; i++) {
    const train = windows[i];
    const test = windows[i + 1];
    const trainRows = pricedMentions.filter((r) => inWindow(r, train));

    const byChannel = new Map();
    for (const row of trainRows) {
      if (typeof row[returnKey] !== 'number') continue;
      const cur = byChannel.get(row.channel_id) || { channelId: row.channel_id, channelTitle: row.channel_title, returns: [] };
      cur.returns.push(row[returnKey]);
      byChannel.set(row.channel_id, cur);
    }
    const ranked = [...byChannel.values()]
      .filter((c) => c.returns.length >= minMentions)
      .map((c) => ({ ...c, avgReturn: avg(c.returns), measurable: c.returns.length }))
      .sort((a, b) => b.avgReturn - a.avgReturn);
    const top = ranked.slice(0, topN);
    const topIds = new Set(top.map((c) => c.channelId));

    const testRows = pricedMentions.filter((r) => topIds.has(r.channel_id) && inWindow(r, test));
    const testReturns = testRows.map((r) => r[returnKey]).filter((v) => typeof v === 'number');
    combinedReturns.push(...testReturns);

    foldResults.push({
      fold: i + 1,
      trainWindow: train,
      testWindow: test,
      qualifyingCreators: ranked.length,
      empty: top.length === 0,
      inSample: top.map((c) => ({
        channelId: c.channelId,
        channelTitle: c.channelTitle,
        avgReturn: c.avgReturn,
        measurable: c.measurable,
      })),
      outOfSample: {
        mentions: testRows.length,
        measurable: testReturns.length,
        avgReturn: avg(testReturns),
        winRate: testReturns.length ? testReturns.filter((v) => v > 0).length / testReturns.length : null,
        benchmarkAvgReturn30d: avg(testRows.map((r) => r.benchmark_return_30d)),
      },
    });
  }
  return {
    foldResults,
    combined: {
      measurable: combinedReturns.length,
      avgReturn: avg(combinedReturns),
      winRate: combinedReturns.length
        ? combinedReturns.filter((v) => v > 0).length / combinedReturns.length
        : null,
    },
  };
}

export async function runYoutubeWalkForward(
  { startDate, endDate, folds = 4, topN = 3, horizon = '30d', minMentions = 5 } = {},
  { provider = alpacaPriceProvider } = {}
) {
  if (!HORIZONS.includes(horizon)) {
    throw new Error(`horizon must be one of ${HORIZONS.join(', ')}`);
  }
  folds = Math.max(2, Math.floor(Number(folds) || 4));
  topN = Math.max(1, Math.floor(Number(topN) || 3));
  minMentions = Math.max(1, Math.floor(Number(minMentions) || 5));
  const windows = splitWindows(startDate, endDate, folds); // validates the range

  const mentions = listAssetMentions({ limit: 10_000 }).filter((m) => {
    if (!['bullish', 'bearish'].includes(m.direction)) return false;
    const day = String(m.event_time || '').slice(0, 10);
    return day >= startDate && day <= endDate;
  });

  const params = { startDate, endDate, folds, topN, horizon, minMentions };
  const runId = createYoutubeBacktestRun({
    name: `Creator walk-forward ${startDate} → ${endDate}`,
    module_key: 'youtube-wf',
    strategy_config: params,
    start_date: startDate,
    end_date: endDate,
    status: 'running',
  });

  try {
    const priced = await priceMentions(mentions, [horizon, '30d'], provider);
    // priceMentions returns rows keyed by mention_id — re-attach channel info.
    const byMentionId = new Map(mentions.map((m) => [m.id, m]));
    for (const row of priced) {
      const mention = byMentionId.get(row.mention_id);
      row.channel_id = mention?.channel_id ?? null;
      row.channel_title = mention?.channel_title ?? null;
      row.event_time = mention?.event_time ?? row.entry_time;
    }

    const { foldResults, combined } = assembleFolds(priced, windows, {
      topN,
      minMentions,
      returnKey: `return_${horizon}`,
    });

    const creatorsConsidered = new Set(mentions.map((m) => m.channel_id)).size;
    const emptyFolds = foldResults.filter((f) => f.empty).length;
    const warnings = [];
    if (emptyFolds > 0) {
      warnings.push(
        `${emptyFolds} of ${foldResults.length} folds had no creators with ≥${minMentions} measurable in-sample mentions — ` +
          'the range likely exceeds data coverage or the folds are too short.'
      );
    }
    if (topN > creatorsConsidered) {
      warnings.push(
        `topN (${topN}) exceeds the ${creatorsConsidered} creators in the data — selection is not filtering anyone out.`
      );
    }
    if (combined.measurable < 20) {
      warnings.push(
        `Only ${combined.measurable} measurable out-of-sample mentions — treat results as directional only.`
      );
    }

    const results = {
      kind: 'youtube-walk-forward',
      horizon,
      folds,
      topN,
      minMentions,
      mentionsConsidered: mentions.length,
      creatorsConsidered,
      foldResults,
      combined,
      warning: warnings.length ? warnings.join(' ') : null,
    };
    updateYoutubeBacktestRun(runId, {
      status: 'complete',
      completed_at: new Date().toISOString(),
      results,
    });
    return { id: runId, ...getYoutubeBacktestRun(runId) };
  } catch (err) {
    updateYoutubeBacktestRun(runId, { status: 'failed', completed_at: new Date().toISOString() });
    throw err;
  }
}
