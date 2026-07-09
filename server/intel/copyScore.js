import { freshnessScore } from './freshness.js';

const WEIGHTS = {
  freshness: 20,
  politicianEdge: 20,
  conviction: 15,
  alreadyMoved: 15,
  committeeRelevance: 15,
  cluster: 10,
  liquidity: 5,
};

function round(value, digits = 1) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function interp(x, x0, y0, x1, y1) {
  if (x <= x0) return y0;
  if (x >= x1) return y1;
  return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
}

function factor(score, weight, detail, hasData = true) {
  return { score: round(score), weight, detail, hasData };
}

function amountConviction(amountMid) {
  if (!Number.isFinite(amountMid)) return 50;
  if (amountMid < 15_000) return 30;
  if (amountMid < 50_000) return 50;
  if (amountMid < 100_000) return 65;
  if (amountMid < 250_000) return 75;
  if (amountMid < 1_000_000) return 85;
  return 95;
}

function clusterScore(count) {
  if (count >= 4) return 90;
  if (count === 3) return 75;
  if (count === 2) return 60;
  return 40;
}

function liquidityScore(avgDollarVolume, isOption) {
  if (isOption) return 10;
  if (!Number.isFinite(avgDollarVolume)) return 50;
  if (avgDollarVolume >= 50_000_000) return 100;
  if (avgDollarVolume >= 10_000_000) return 70;
  if (avgDollarVolume >= 1_000_000) return 40;
  return 10;
}

function movedScore(trade, driftPct) {
  if (!Number.isFinite(driftPct)) return { score: 50, hasData: false, directionalMove: null };
  const directionalMove = trade.type === 'sell' ? -driftPct : driftPct;
  if (directionalMove < 0) return { score: 75, hasData: true, directionalMove };
  if (directionalMove <= 2) return { score: 90, hasData: true, directionalMove };
  if (directionalMove <= 5) return { score: interp(directionalMove, 2, 90, 5, 60), hasData: true, directionalMove };
  if (directionalMove <= 10) return { score: interp(directionalMove, 5, 60, 10, 30), hasData: true, directionalMove };
  if (directionalMove <= 15) return { score: interp(directionalMove, 10, 30, 15, 10), hasData: true, directionalMove };
  return { score: 10, hasData: true, directionalMove };
}

function measuredTradeCount(stats) {
  return stats?.stats?.measurable_buys_90d ?? stats?.stats?.measured_buys ?? stats?.buy_count ?? 0;
}

function criticalWarningCodes(warnings) {
  return warnings.filter((w) => w.severity === 'critical').map((w) => w.code);
}

export function computeCopyScore(trade, ctx = {}) {
  const now = ctx.now ? new Date(ctx.now) : new Date();
  const fresh = freshnessScore(trade, now);
  const freshness = factor(
    fresh.score ?? 50,
    WEIGHTS.freshness,
    fresh.score == null
      ? 'No usable transaction or disclosure date; freshness is unknown.'
      : `${fresh.lagDays} days since ${fresh.basis === 'transaction' ? 'the trade' : 'disclosure'}; freshness score ${fresh.score}.`,
    fresh.score != null
  );

  const stats = ctx.politicianStats ?? null;
  const edgeScore = stats?.edge_score;
  const politicianEdge = factor(
    edgeScore ?? 50,
    WEIGHTS.politicianEdge,
    edgeScore == null
      ? 'No proven politician edge yet; using neutral score.'
      : `Politician edge score is ${round(edgeScore)} from historical 90-day returns.`,
    edgeScore != null
  );

  const repeatBuys = Number(ctx.repeatBuyCount ?? 0);
  let convictionValue = amountConviction(Number(trade.amount_mid));
  if (trade.type === 'buy' && repeatBuys > 0) convictionValue += 10;
  if (['spouse', 'dependent'].includes(trade.owner)) convictionValue -= 10;
  convictionValue = Math.max(0, Math.min(100, convictionValue));
  const convictionParts = [
    Number.isFinite(Number(trade.amount_mid))
      ? `amount midpoint $${Number(trade.amount_mid).toLocaleString('en-US')}`
      : 'amount midpoint unavailable',
  ];
  if (repeatBuys > 0) convictionParts.push(`${repeatBuys} prior same-ticker buy${repeatBuys === 1 ? '' : 's'} in 90 days`);
  if (['spouse', 'dependent'].includes(trade.owner)) convictionParts.push(`${trade.owner} owner penalty`);
  const conviction = factor(convictionValue, WEIGHTS.conviction, convictionParts.join('; ') + '.');

  const moved = movedScore(trade, ctx.driftPct);
  const alreadyMoved = factor(
    moved.score,
    WEIGHTS.alreadyMoved,
    moved.directionalMove == null
      ? 'No price drift data since the transaction date.'
      : `${round(moved.directionalMove, 2)}% move in the trade direction since transaction.`,
    moved.hasData
  );

  const clusterCount = Math.max(1, Number(ctx.clusterCount ?? 1));
  // A lone trade (count 1) is only the trader themselves — no corroborating
  // crowd signal — so it scores low but does not count as data-backed weight.
  const cluster = factor(
    clusterScore(clusterCount),
    WEIGHTS.cluster,
    `${clusterCount} distinct politician${clusterCount === 1 ? '' : 's'} traded ${trade.ticker} ${trade.type} within 30 days.`,
    clusterCount > 1
  );

  const adv = Number(ctx.avgDollarVolume);
  const liquidity = factor(
    liquidityScore(adv, Boolean(trade.is_option)),
    WEIGHTS.liquidity,
    trade.is_option
      ? 'Options trade; equity liquidity proxy is not enough for auto-copying.'
      : Number.isFinite(adv)
        ? `Average dollar volume is about $${Math.round(adv).toLocaleString('en-US')}.`
        : 'Average dollar volume unavailable.',
    trade.is_option ? true : Number.isFinite(adv)
  );

  const relevance = ctx.relevanceScore;
  const relevanceSignals = Array.isArray(ctx.relevanceSignals) ? ctx.relevanceSignals : [];
  const committeeRelevance = factor(
    Number.isFinite(relevance) ? relevance : 50,
    WEIGHTS.committeeRelevance,
    Number.isFinite(relevance)
      ? relevanceSignals.length
        ? relevanceSignals.map((s) => s.text).filter(Boolean).join(' ')
        : `Political relevance score is ${round(relevance)}.`
      : 'Committee relevance is not wired until the knowledge graph phase.',
    Number.isFinite(relevance)
  );

  const factors = {
    freshness,
    politicianEdge,
    conviction,
    alreadyMoved,
    cluster,
    liquidity,
    committeeRelevance,
  };

  const warnings = [];
  if (fresh.lagDays != null && fresh.lagDays > 30) {
    warnings.push({
      code: 'stale-filing',
      severity: fresh.lagDays > 45 ? 'critical' : 'caution',
      message: `Filing is ${fresh.lagDays} days after the ${fresh.basis === 'transaction' ? 'trade' : 'disclosure basis'}.`,
    });
  }
  if (moved.directionalMove != null && moved.directionalMove > 10) {
    warnings.push({
      code: 'already-priced-in',
      severity: moved.directionalMove > 18 ? 'critical' : 'caution',
      message: `${trade.ticker} already moved ${round(moved.directionalMove, 2)}% in the trade direction.`,
    });
  }
  if (Number.isFinite(Number(trade.amount_mid)) && Number(trade.amount_mid) < 15_000 && repeatBuys === 0) {
    warnings.push({ code: 'low-conviction', severity: 'caution', message: 'Small disclosed amount with no recent repeat buy.' });
  }
  if (edgeScore != null && edgeScore < 35 && measuredTradeCount(stats) >= 10) {
    warnings.push({ code: 'weak-trader', severity: 'caution', message: `Historical edge score is weak (${round(edgeScore)}).` });
  }
  if (liquidity.score <= 40) {
    warnings.push({ code: 'illiquid', severity: 'caution', message: 'Liquidity score is low.' });
  }
  if (trade.is_option) {
    warnings.push({ code: 'options-trade', severity: 'critical', message: 'Options disclosures are never auto-tradable.' });
  }
  if ((trade.parse_confidence ?? 1) < 0.8) {
    warnings.push({ code: 'low-parse-confidence', severity: 'critical', message: `Parse confidence is ${trade.parse_confidence}.` });
  }
  if (Number.isFinite(relevance) && relevance < 25) {
    warnings.push({ code: 'no-political-relevance', severity: 'caution', message: 'No clear political relevance for this ticker yet.' });
  }

  const totalWeight = Object.values(factors).reduce((sum, f) => sum + f.weight, 0);
  const score = round(
    Object.values(factors).reduce((sum, f) => sum + f.score * f.weight, 0) / totalWeight
  );
  const confidence = round(
    Object.values(factors).reduce((sum, f) => sum + (f.hasData ? f.weight : 0), 0) / totalWeight,
    3
  );

  const criticalCodes = criticalWarningCodes(warnings);
  let recommendation;
  if (confidence < 0.5) recommendation = 'manual-review';
  else if (criticalCodes.length > 0) {
    recommendation = criticalCodes.length === 1 && criticalCodes[0] === 'low-parse-confidence'
      ? 'manual-review'
      : 'avoid';
  } else if (score >= 75 && confidence >= 0.6) recommendation = 'copy-candidate';
  else if (score >= 55) recommendation = 'watchlist';
  else recommendation = 'avoid';

  return { score, confidence, recommendation, factors, warnings };
}
