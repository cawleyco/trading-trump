// Creator-alpha trust policy: pure functions deciding when a creator's track
// record is statistically meaningful and how to label it. Mirrors the
// politician edge-score policy (server/intel/politicianStats.js): below the
// minimum sample the alpha score is NULL — "unknown" must never masquerade as
// "proven good" (or "proven bad").

export const MIN_ALPHA_MENTIONS = 10;

// pump_dump_rate at/above this (with enough measurable pairs) marks a fade
// candidate regardless of average return — spikes that retrace are the harm.
export const PUMP_FADE_THRESHOLD = 0.35;

// Percentile rank a creator must reach (among qualifying creators) to be a
// follow candidate. Percentile alone is relative, so follow additionally
// requires a positive average 30d return — being the best of a losing cohort
// is not edge.
export const FOLLOW_MIN_PERCENTILE = 65;

export const LABEL_FOLLOW = 'follow';
export const LABEL_FADE = 'fade';
export const LABEL_NEUTRAL = 'neutral';
export const LABEL_INSUFFICIENT = 'insufficient_data';

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

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Raw per-creator metrics from priced mention results (_resultForMention
 * rows). Rates are computed only over mentions with real price data for the
 * relevant window — a data gap is not a loss.
 */
export function rawCreatorMetrics(results) {
  const winRateOver = (key) => {
    const usable = results.filter((r) => typeof r[key] === 'number');
    return usable.length ? usable.filter((r) => r[key] > 0).length / usable.length : null;
  };
  const measurable30 = results.filter((r) => typeof r.return_30d === 'number').length;
  const pdMeasurable = results.filter(
    (r) => typeof r.return_24h === 'number' && typeof r.return_7d === 'number'
  );
  return {
    sample_size: results.length,
    measurable_mentions: measurable30,
    avg_return_1h: avg(results.map((r) => r.return_1h)),
    avg_return_6h: avg(results.map((r) => r.return_6h)),
    avg_return_24h: avg(results.map((r) => r.return_24h)),
    avg_return_7d: avg(results.map((r) => r.return_7d)),
    avg_return_30d: avg(results.map((r) => r.return_30d)),
    avg_return_90d: avg(results.map((r) => r.return_90d)),
    win_rate_24h: winRateOver('return_24h'),
    win_rate_7d: winRateOver('return_7d'),
    win_rate_30d: winRateOver('return_30d'),
    median_return_30d: median(results.map((r) => r.return_30d)),
    pump_dump_rate: pdMeasurable.length
      ? pdMeasurable.filter((r) => r.return_24h > 5 && r.return_7d < -5).length / pdMeasurable.length
      : null,
    pd_measurable: pdMeasurable.length,
  };
}

/**
 * Percentile alpha across creators. Only creators with at least
 * MIN_ALPHA_MENTIONS measurable 30d mentions qualify; everyone else maps to
 * no entry (alpha stays null). rows: [{ channelId, measurable, avgReturn30d }]
 */
export function percentileAlphaScores(rows) {
  const eligible = rows
    .filter((r) => r.measurable >= MIN_ALPHA_MENTIONS && typeof r.avgReturn30d === 'number')
    .sort((a, b) => a.avgReturn30d - b.avgReturn30d);
  const scores = new Map();
  for (let i = 0; i < eligible.length; i++) {
    const score = eligible.length === 1 ? 100 : (i / (eligible.length - 1)) * 100;
    scores.set(eligible[i].channelId, round(score, 1));
  }
  return scores;
}

/**
 * Follow/fade labeling. Fading a creator needs the same statistical bar as
 * following one — a "reliably wrong" call on 4 mentions is still noise.
 */
export function labelCreator({ measurable, avgReturn30d, alphaScore, pumpDumpRate, pdMeasurable }) {
  if (measurable < MIN_ALPHA_MENTIONS) {
    return {
      label: LABEL_INSUFFICIENT,
      alpha_score: null,
      fade_score: null,
      alpha_basis: `requires ${MIN_ALPHA_MENTIONS} measurable 30d mentions (has ${measurable})`,
    };
  }
  const pumpy =
    typeof pumpDumpRate === 'number' &&
    pdMeasurable >= MIN_ALPHA_MENTIONS &&
    pumpDumpRate >= PUMP_FADE_THRESHOLD;
  const losing = typeof avgReturn30d === 'number' && avgReturn30d < 0;
  const basis = `avg_return_30d percentile over ${measurable} measurable mentions`;
  if (pumpy || losing) {
    return {
      label: LABEL_FADE,
      alpha_score: alphaScore ?? null,
      fade_score: round(100 - (alphaScore ?? 50)),
      alpha_basis: basis,
    };
  }
  if (typeof alphaScore === 'number' && alphaScore >= FOLLOW_MIN_PERCENTILE && avgReturn30d > 0) {
    return { label: LABEL_FOLLOW, alpha_score: alphaScore, fade_score: 0, alpha_basis: basis };
  }
  return { label: LABEL_NEUTRAL, alpha_score: alphaScore ?? null, fade_score: 0, alpha_basis: basis };
}
