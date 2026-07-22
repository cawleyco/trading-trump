// Narrative-alpha policy: pure functions that aggregate priced mention results
// by *narrative* (mention_type × direction) and measure the price impact of a
// narrative as an ABNORMAL return — the asset's move minus the window-matched
// SPY move — so broad-market drift is not mistaken for a video's effect.
//
// Mirrors server/influence/creatorStats.js (which aggregates by creator). Same
// discipline: below the minimum sample the impact is NULL, never a confident
// zero — a 3-mention narrative is noise, not signal.

// Windows reported for a narrative. Impact typically decays, so short windows
// (24h/7d) carry most of the "did the video move it" signal; 30d/90d read as
// thesis follow-through.
export const NARRATIVE_WINDOWS = ['1h', '6h', '24h', '7d', '30d', '90d'];

// A narrative needs at least this many measurable (priced) mentions in a window
// before its abnormal return is reported for that window.
export const MIN_NARRATIVE_MENTIONS = 8;

function avg(vals) {
  const usable = vals.filter((v) => typeof v === 'number');
  return usable.length ? usable.reduce((a, b) => a + b, 0) / usable.length : null;
}

function median(vals) {
  const usable = vals.filter((v) => typeof v === 'number').sort((a, b) => a - b);
  if (!usable.length) return null;
  const mid = Math.floor(usable.length / 2);
  return usable.length % 2 ? usable[mid] : (usable[mid - 1] + usable[mid]) / 2;
}

function stdev(vals) {
  const usable = vals.filter((v) => typeof v === 'number');
  if (usable.length < 2) return null;
  const m = usable.reduce((a, b) => a + b, 0) / usable.length;
  const variance = usable.reduce((a, b) => a + (b - m) ** 2, 0) / (usable.length - 1);
  return Math.sqrt(variance);
}

function round(value, digits = 3) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Per-window abnormal-return stats for one narrative group. `results` are
 * _resultForMention rows (carrying abnormal_return_<window> / raw_return_<window>).
 * A window with fewer than MIN_NARRATIVE_MENTIONS measurable mentions reports
 * `measurable` but null point estimates — presence without false confidence.
 */
export function windowStats(results, window) {
  const key = `abnormal_return_${window}`;
  const rawKey = `raw_return_${window}`;
  const abnormal = results.map((r) => r[key]).filter((v) => typeof v === 'number');
  const raw = results.map((r) => r[rawKey]).filter((v) => typeof v === 'number');
  const measurable = abnormal.length;
  if (measurable < MIN_NARRATIVE_MENTIONS) {
    return { window, measurable, insufficient: true };
  }
  const mean = avg(abnormal);
  const sd = stdev(abnormal);
  // Standard error of the mean and a rough t-stat: |mean| / SE. |t| >= 2 is the
  // conventional ~95% bar — a quick "is this abnormal move distinguishable from
  // zero" flag, not a substitute for a full event-study test.
  const se = sd != null ? sd / Math.sqrt(measurable) : null;
  const tStat = se ? mean / se : null;
  return {
    window,
    measurable,
    insufficient: false,
    avg_abnormal_return: round(mean),
    median_abnormal_return: round(median(abnormal)),
    avg_raw_return: round(avg(raw)),
    stdev_abnormal_return: round(sd),
    // Share of mentions where the asset beat SPY over the window.
    beat_market_rate: round(abnormal.filter((v) => v > 0).length / measurable, 3),
    t_stat: round(tStat, 2),
    significant: tStat != null && Math.abs(tStat) >= 2,
  };
}

/**
 * Full metrics for one narrative group across every window.
 * `group` = { narrative, direction, assetType }.
 */
export function rawNarrativeMetrics(group, results) {
  const byWindow = {};
  for (const window of NARRATIVE_WINDOWS) byWindow[window] = windowStats(results, window);
  return {
    ...group,
    sample_size: results.length,
    priced: results.filter((r) => r.entry_price != null).length,
    by_window: byWindow,
  };
}

/**
 * Group priced results by narrative and compute metrics per group. `keyOf`
 * maps a result to its group key parts; defaults to mention_type × direction.
 * The narrative/direction live on result.result_metadata (set by
 * _resultForMention) or directly on the result — callers may attach either.
 */
export function aggregateByNarrative(results, keyOf = defaultKeyOf) {
  const groups = new Map();
  for (const r of results) {
    const g = keyOf(r);
    if (!g?.narrative) continue;
    const id = `${g.narrative}|${g.direction || 'any'}|${g.assetType || 'any'}`;
    if (!groups.has(id)) groups.set(id, { group: g, rows: [] });
    groups.get(id).rows.push(r);
  }
  return [...groups.values()].map(({ group, rows }) => rawNarrativeMetrics(group, rows));
}

function defaultKeyOf(r) {
  const meta = r.result_metadata || {};
  return {
    narrative: r.narrative ?? r.mention_type ?? meta.mentionType ?? null,
    direction: r.direction ?? meta.direction ?? null,
    assetType: r.asset_type ?? meta.assetType ?? null,
  };
}
