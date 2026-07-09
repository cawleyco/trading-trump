import { config } from '../config.js';
import {
  createPendingApproval,
  expirePendingApprovals,
  getCongressTradeByKey,
  getStrategy,
  getTradeScore,
  isTradeInPendingReview,
  listCongressTrades,
  listStrategies,
  recordStrategyMatch,
  updateStrategyMatchOutcome,
  insertBacktest,
} from '../db.js';
import { notify } from '../notifier.js';
import { makeTradeSignal } from '../signal.js';
import { processSignal } from '../riskManager.js';
import { scoreTrade } from './scoreRunner.js';
import { dispatchStrategyMatch } from './alertEngine.js';
import { simulateTrades } from '../backtest/simulate.js';

const FILTER_KEYS = new Set([
  'direction',
  'minCopyScore',
  'minConfidence',
  'maxDisclosureLagDays',
  'maxDriftPct',
  'minClusterCount',
  'minRelevanceScore',
  'politicians',
  'excludePoliticians',
  'sectors',
  'excludeWarnings',
  'minAmountMid',
  'minEdgeScore',
]);

const ACTION_KEYS = new Set(['mode', 'fund', 'notionalUsd']);
const TOP_KEYS = new Set(['source', 'filters', 'action']);
const MODES = new Set(['watch', 'paper', 'manual', 'auto']);

const EMPTY_FILTERS = {
  direction: null,
  minCopyScore: null,
  minConfidence: null,
  maxDisclosureLagDays: null,
  maxDriftPct: null,
  minClusterCount: null,
  minRelevanceScore: null,
  politicians: [],
  excludePoliticians: [],
  sectors: [],
  excludeWarnings: [],
  minAmountMid: null,
  minEdgeScore: null,
};

function unknownKeys(obj, allowed) {
  return Object.keys(obj || {}).filter((key) => !allowed.has(key));
}

function asNumber(value, key, { min = -Infinity, max = Infinity } = {}) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`${key} must be a number between ${min} and ${max}`);
  }
  return n;
}

function asStringArray(value, key) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${key} must be an array`);
  return value.map((v) => String(v || '').trim()).filter(Boolean);
}

export function validateStrategyDefinition(definition) {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
    throw new Error('strategy definition must be an object');
  }
  const topUnknown = unknownKeys(definition, TOP_KEYS);
  if (topUnknown.length) throw new Error(`unknown strategy keys: ${topUnknown.join(', ')}`);
  if ((definition.source ?? 'congress') !== 'congress') throw new Error('source must be "congress"');

  const filterUnknown = unknownKeys(definition.filters || {}, FILTER_KEYS);
  if (filterUnknown.length) throw new Error(`unknown filter keys: ${filterUnknown.join(', ')}`);
  const actionUnknown = unknownKeys(definition.action || {}, ACTION_KEYS);
  if (actionUnknown.length) throw new Error(`unknown action keys: ${actionUnknown.join(', ')}`);

  const inputFilters = definition.filters || {};
  const filters = {
    ...EMPTY_FILTERS,
    direction: inputFilters.direction ?? null,
    minCopyScore: asNumber(inputFilters.minCopyScore, 'minCopyScore', { min: 0, max: 100 }),
    minConfidence: asNumber(inputFilters.minConfidence, 'minConfidence', { min: 0, max: 1 }),
    maxDisclosureLagDays: asNumber(inputFilters.maxDisclosureLagDays, 'maxDisclosureLagDays', { min: 0 }),
    maxDriftPct: asNumber(inputFilters.maxDriftPct, 'maxDriftPct', { min: 0 }),
    minClusterCount: asNumber(inputFilters.minClusterCount, 'minClusterCount', { min: 1 }),
    minRelevanceScore: asNumber(inputFilters.minRelevanceScore, 'minRelevanceScore', { min: 0, max: 100 }),
    politicians: asStringArray(inputFilters.politicians, 'politicians'),
    excludePoliticians: asStringArray(inputFilters.excludePoliticians, 'excludePoliticians'),
    sectors: asStringArray(inputFilters.sectors, 'sectors'),
    excludeWarnings: asStringArray(inputFilters.excludeWarnings, 'excludeWarnings'),
    minAmountMid: asNumber(inputFilters.minAmountMid, 'minAmountMid', { min: 0 }),
    minEdgeScore: asNumber(inputFilters.minEdgeScore, 'minEdgeScore', { min: 0, max: 100 }),
  };
  if (filters.direction != null && !['buy', 'sell'].includes(filters.direction)) {
    throw new Error('direction must be "buy" or "sell"');
  }

  const action = {
    mode: definition.action?.mode ?? 'watch',
    fund: definition.action?.fund ? String(definition.action.fund).trim() : 'paper',
    notionalUsd: asNumber(definition.action?.notionalUsd ?? 500, 'notionalUsd', { min: 1 }),
  };
  if (!MODES.has(action.mode)) throw new Error('action.mode must be watch, paper, manual, or auto');

  return { source: 'congress', filters, action };
}

function daysBetween(start, end) {
  if (!start || !end) return null;
  const ms = new Date(`${end.slice(0, 10)}T00:00:00Z`).getTime() -
    new Date(`${start.slice(0, 10)}T00:00:00Z`).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.round(ms / 86400_000);
}

function leadingNumber(text) {
  const match = String(text || '').match(/-?\d+(\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function scoreFactor(score, key) {
  return score?.factors && typeof score.factors === 'object' ? score.factors[key] : null;
}

function metricContext(trade, score, ctx = {}) {
  const sectorInput = ctx.sectors ?? (ctx.sector ? [ctx.sector] : []);
  return {
    lagDays: ctx.disclosureLagDays ?? daysBetween(trade.transaction_date, trade.disclosure_date),
    driftPct: ctx.driftPct ?? null,
    clusterCount: ctx.clusterCount ?? leadingNumber(scoreFactor(score, 'cluster')?.detail),
    relevanceScore: ctx.relevanceScore ?? scoreFactor(score, 'committeeRelevance')?.score ?? null,
    edgeScore: ctx.edgeScore ?? scoreFactor(score, 'politicianEdge')?.score ?? null,
    sectors: [sectorInput].flat().filter(Boolean),
    warnings: (score?.warnings || []).map((w) => w.code).filter(Boolean),
  };
}

function pushFail(failed, code, detail) {
  failed.push(detail ? { code, detail } : { code });
}

export function evaluateStrategyDefinition(trade, score, definition, ctx = {}) {
  const clean = validateStrategyDefinition(definition);
  const f = clean.filters;
  const metrics = metricContext(trade, score, ctx);
  const failedFilters = [];

  if (f.direction && trade.type !== f.direction) pushFail(failedFilters, 'direction', `${trade.type} != ${f.direction}`);
  if (f.minCopyScore != null && !(Number(score?.score) >= f.minCopyScore)) pushFail(failedFilters, 'minCopyScore', `${score?.score ?? 'missing'} < ${f.minCopyScore}`);
  if (f.minConfidence != null && !(Number(score?.confidence) >= f.minConfidence)) pushFail(failedFilters, 'minConfidence', `${score?.confidence ?? 'missing'} < ${f.minConfidence}`);
  if (f.maxDisclosureLagDays != null && !(metrics.lagDays != null && metrics.lagDays <= f.maxDisclosureLagDays)) pushFail(failedFilters, 'maxDisclosureLagDays', `${metrics.lagDays ?? 'missing'} > ${f.maxDisclosureLagDays}`);
  if (f.maxDriftPct != null && !(metrics.driftPct != null && Math.abs(metrics.driftPct) <= f.maxDriftPct)) pushFail(failedFilters, 'maxDriftPct', `${metrics.driftPct ?? 'missing'} > ${f.maxDriftPct}`);
  if (f.minClusterCount != null && !(Number(metrics.clusterCount) >= f.minClusterCount)) pushFail(failedFilters, 'minClusterCount', `${metrics.clusterCount ?? 'missing'} < ${f.minClusterCount}`);
  if (f.minRelevanceScore != null && !(Number(metrics.relevanceScore) >= f.minRelevanceScore)) pushFail(failedFilters, 'minRelevanceScore', `${metrics.relevanceScore ?? 'missing'} < ${f.minRelevanceScore}`);
  if (f.politicians.length && !f.politicians.includes(trade.politician)) pushFail(failedFilters, 'politicians', `${trade.politician} not allowed`);
  if (f.excludePoliticians.includes(trade.politician)) pushFail(failedFilters, 'excludePoliticians', `${trade.politician} excluded`);
  if (f.sectors.length && !metrics.sectors.some((s) => f.sectors.includes(s))) pushFail(failedFilters, 'sectors', 'no sector match');
  const blockedWarning = f.excludeWarnings.find((code) => metrics.warnings.includes(code));
  if (blockedWarning) pushFail(failedFilters, 'excludeWarnings', blockedWarning);
  if (f.minAmountMid != null && !(Number(trade.amount_mid) >= f.minAmountMid)) pushFail(failedFilters, 'minAmountMid', `${trade.amount_mid ?? 'missing'} < ${f.minAmountMid}`);
  if (f.minEdgeScore != null && !(Number(metrics.edgeScore) >= f.minEdgeScore)) pushFail(failedFilters, 'minEdgeScore', `${metrics.edgeScore ?? 'missing'} < ${f.minEdgeScore}`);

  return { matched: failedFilters.length === 0, failedFilters };
}

export function evaluateStrategies(trade, score, strategies, ctx = {}) {
  return strategies.map((strategy) => {
    const result = evaluateStrategyDefinition(trade, score, strategy.definition, ctx);
    return {
      strategyId: strategy.id,
      matched: result.matched,
      failedFilters: result.failedFilters,
    };
  });
}

function rawTradeReference(trade, score, strategy) {
  return {
    tradeKey: trade.trade_key,
    politician: trade.politician,
    ticker: trade.ticker,
    type: trade.type,
    transactionDate: trade.transaction_date,
    disclosureDate: trade.disclosure_date,
    amountRange: trade.amount_range,
    strategy: { id: strategy.id, name: strategy.name, action: strategy.definition.action },
    copyScore: score?.score ?? null,
    recommendation: score?.recommendation ?? null,
  };
}

function signalForStrategy(trade, score, strategy, rationalePrefix = null) {
  const prefix = rationalePrefix || `Strategy "${strategy.name}" matched`;
  return makeTradeSignal({
    source: 'congress',
    ticker: trade.ticker,
    direction: trade.type,
    confidence: score?.confidence ?? null,
    rationale: `${prefix}: ${trade.politician} disclosed ${trade.type} of ${trade.ticker} ` +
      `(score ${score?.score ?? 'unscored'}, disclosed ${trade.disclosure_date})`,
    rawReference: rawTradeReference(trade, score, strategy),
    eventTimestamp: trade.disclosure_date,
  });
}

async function createStrategySignal(trade, score, strategy) {
  const signal = signalForStrategy(trade, score, strategy);
  const fund = strategy.definition.action.fund || undefined;
  const outcomes = await processSignal(signal, { onlyFund: fund });
  return outcomes[0]?.signalId ?? null;
}

export async function processTradeThroughStrategies(tradeKey, opts = {}) {
  expirePendingApprovals();
  const trade = opts.trade ?? getCongressTradeByKey(tradeKey);
  if (!trade) throw new Error(`unknown trade key "${tradeKey}"`);
  const score = opts.score ?? getTradeScore(tradeKey) ?? await scoreTrade(tradeKey);
  const strategies = opts.strategies ?? listStrategies({ includeDisabled: false });
  const inReview = opts.inReview ?? (trade.parse_confidence < 0.8 || isTradeInPendingReview(tradeKey));
  const results = [];

  for (const strategy of strategies) {
    const definition = validateStrategyDefinition(strategy.definition);
    const evaluation = evaluateStrategyDefinition(trade, score, definition, opts.ctx || {});
    const matchId = recordStrategyMatch({
      strategyId: strategy.id,
      tradeKey,
      matched: evaluation.matched,
      failedFilters: evaluation.failedFilters,
      outcome: evaluation.matched ? null : 'filter-failed',
    });
    let outcome = evaluation.matched ? 'watch' : 'filter-failed';
    let signalId = null;
    let approval = null;

    if (evaluation.matched) {
      dispatchStrategyMatch(strategy, trade, score);
      const mode = inReview ? 'watch' : definition.action.mode;
      if (inReview && definition.action.mode !== 'watch') {
        outcome = 'skipped-review-queue';
      } else if (mode === 'manual') {
        approval = createPendingApproval({
          strategyId: strategy.id,
          tradeKey,
          proposed: {
            ticker: trade.ticker,
            direction: trade.type,
            notionalUsd: definition.action.notionalUsd,
            fund: definition.action.fund,
          },
          ttlHours: config.signals.approvalTtlHours,
        });
        outcome = 'pending-approval';
        notify('Strategy approval needed', `${strategy.name}: ${trade.type} ${trade.ticker} from ${trade.politician}`);
      } else if (mode === 'paper' || mode === 'auto') {
        signalId = await createStrategySignal(trade, score, { ...strategy, definition });
        outcome = 'signal-created';
      }
      updateStrategyMatchOutcome(matchId, { outcome, signalId });
    }
    results.push({ strategyId: strategy.id, matched: evaluation.matched, failedFilters: evaluation.failedFilters, outcome, signalId, approval });
  }
  return results;
}

export async function approvePendingStrategySignal(approval, { thesisCard } = {}) {
  const strategy = getStrategy(approval.strategy_id);
  const trade = getCongressTradeByKey(approval.trade_key);
  const score = getTradeScore(approval.trade_key) ?? await scoreTrade(approval.trade_key);
  if (!strategy || !trade) throw new Error('approval references a missing strategy or trade');
  const summary = thesisCard?.card?.summary || thesisCard?.card?.headline || thesisCard?.polished || '';
  const signal = signalForStrategy(
    trade,
    score,
    strategy,
    `Manual approval for strategy "${strategy.name}"${summary ? ` (${summary})` : ''}`
  );
  const outcomes = await processSignal(signal, { onlyFund: approval.proposed?.fund || undefined });
  return { signalId: outcomes[0]?.signalId ?? null, outcomes };
}

function rowToBacktestTrade(row) {
  return {
    ...row,
    type: row.type,
    transactionDate: row.transaction_date,
    disclosureDate: row.disclosure_date,
    amountRange: row.amount_range,
  };
}

export async function runStrategyBacktest(strategyId, {
  startDate,
  endDate,
  notionalPerTrade,
  exitRule = 'hold_90',
  stopLossPct = null,
  takeProfitPct = null,
} = {}) {
  const strategy = getStrategy(strategyId);
  if (!strategy) throw new Error('strategy not found');
  const definition = validateStrategyDefinition(strategy.definition);
  const trades = listCongressTrades({ since: startDate, until: endDate, limit: 5000 });
  const matched = [];
  let unscored = 0;

  for (const trade of trades) {
    let score = getTradeScore(trade.trade_key);
    if (!score) {
      try {
        score = await scoreTrade(trade.trade_key, { trade });
      } catch {
        unscored++;
        continue;
      }
    }
    const evaluation = evaluateStrategyDefinition(trade, score, definition);
    if (!evaluation.matched || !trade.disclosure_date) continue;
    matched.push({ trade, score });
  }

  const plans = matched.map(({ trade, score }) => ({
    ticker: trade.ticker,
    direction: trade.type,
    entryDate: trade.disclosure_date,
    exitDate: null,
    holdDays: exitRule === 'hold_30' ? 30 : exitRule === 'hold_90' ? 90 : null,
    stopLossPct: stopLossPct ?? null,
    takeProfitPct: takeProfitPct ?? null,
    label: `${strategy.name}: ${trade.politician} ${trade.ticker} (disclosed ${trade.disclosure_date})`,
    meta: { tradeKey: trade.trade_key, score: score.score, limitation: 'Drift, cluster, and graph-derived filters use current stored factors when historical as-of data is unavailable.' },
  }));
  const results = await simulateTrades(plans, notionalPerTrade);
  results.kind = 'strategy';
  results.strategy = { id: strategy.id, name: strategy.name };
  results.matchedTrades = matched.length;
  results.unscoredTrades = unscored;
  results.limitation = 'Strategy backtests use disclosure-date entries; drift, cluster, and graph-derived factors may reflect current stored context rather than historical as-of values.';
  const params = { strategyId, startDate, endDate, notionalPerTrade, exitRule, stopLossPct, takeProfitPct };
  const id = insertBacktest({ kind: 'strategy', params, results });
  return { id, params, results };
}
