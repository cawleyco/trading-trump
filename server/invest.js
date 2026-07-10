import { config, enabledFunds, assertStrategyModeAllowed } from './config.js';
import { createStrategy, getStrategy } from './db.js';
import { makeTradeSignal } from './signal.js';
import { previewSignal, processSignal } from './riskManager.js';
import { validateStrategyDefinition } from './intel/strategyEngine.js';

const ORIGIN_KINDS = new Set([
  'backtest',
  'thesis',
  'alert',
  'watchlist',
  'intel',
  'calendar',
  'signal',
  'approval',
  'influence',
  'pipeline',
  'trades',
  'politicians',
  'manual',
]);

export function listInvestFunds() {
  return enabledFunds.map((f) => ({
    name: f.name,
    paper: !!f.paper,
    maxTradeNotionalUsd: f.risk.maxTradeNotionalUsd,
    maxTradePctEquity: f.risk.maxTradePctEquity,
    sources: f.sources,
  }));
}

export function preferredPaperFundName(funds = listInvestFunds()) {
  const paper = funds.find((f) => f.paper);
  return paper?.name ?? funds[0]?.name ?? null;
}

function normalizeOrigin(origin) {
  if (origin == null) return { kind: 'manual' };
  if (typeof origin === 'string') {
    const kind = ORIGIN_KINDS.has(origin) ? origin : 'manual';
    return { kind };
  }
  if (typeof origin !== 'object' || Array.isArray(origin)) {
    throw new Error('origin must be an object or string');
  }
  const kind = ORIGIN_KINDS.has(origin.kind) ? origin.kind : 'manual';
  return {
    kind,
    ...(origin.label ? { label: String(origin.label) } : {}),
    ...(origin.backtestId != null ? { backtestId: Number(origin.backtestId) || origin.backtestId } : {}),
    ...(origin.tradeKey ? { tradeKey: String(origin.tradeKey) } : {}),
    ...(origin.strategyId != null ? { strategyId: Number(origin.strategyId) } : {}),
    ...(origin.alertId != null ? { alertId: Number(origin.alertId) } : {}),
    ...(origin.signalId != null ? { signalId: Number(origin.signalId) } : {}),
    ...(origin.surface ? { surface: String(origin.surface) } : {}),
    ...(origin.politician ? { politician: String(origin.politician) } : {}),
  };
}

export function buildManualInvestSignal(body = {}) {
  const ticker = body.ticker;
  const direction = body.direction || 'buy';
  const origin = normalizeOrigin(body.origin);
  const rationale = String(body.rationale || '').trim()
    || `Manual invest from ${origin.label || origin.kind}`;
  return makeTradeSignal({
    source: 'manual',
    ticker,
    direction,
    confidence: body.confidence ?? 1,
    rationale,
    rawReference: {
      manual: true,
      origin,
      ...(body.rawReference && typeof body.rawReference === 'object' ? body.rawReference : {}),
    },
    eventTimestamp: body.eventTimestamp || null,
  });
}

function parseRequestedNotional(value) {
  if (value == null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error('notionalUsd must be a positive number');
  return n;
}

export async function previewInvest(body, opts = {}) {
  const fund = String(body.fund || '').trim();
  if (!fund) throw new Error('fund is required');
  const signal = buildManualInvestSignal(body);
  const requestedNotionalUsd = parseRequestedNotional(body.notionalUsd);
  const preview = await previewSignal(signal, {
    onlyFund: fund,
    requestedNotionalUsd,
    _deps: opts._deps,
    _funds: opts._funds,
  });
  return {
    signal: {
      source: signal.source,
      ticker: signal.ticker,
      direction: signal.direction,
      rationale: signal.rationale,
      origin: signal.rawReference.origin,
    },
    ...preview,
  };
}

export async function confirmInvest(body, opts = {}) {
  const fund = String(body.fund || '').trim();
  if (!fund) throw new Error('fund is required');
  const signal = buildManualInvestSignal(body);
  const requestedNotionalUsd = parseRequestedNotional(body.notionalUsd);
  const outcomes = await processSignal(signal, {
    onlyFund: fund,
    requestedNotionalUsd,
    _deps: opts._deps,
    _funds: opts._funds,
  });
  return { signal, outcomes };
}

function promoteFiltersFromBody(body = {}) {
  if (body.filters && typeof body.filters === 'object') return body.filters;
  const from = body.from || {};
  const filters = {};
  if (from.politician) filters.politicians = [String(from.politician)];
  if (Array.isArray(from.politicians) && from.politicians.length) {
    filters.politicians = from.politicians.map(String);
  }
  if (from.direction === 'buy' || from.direction === 'sell') filters.direction = from.direction;
  if (from.minCopyScore != null) filters.minCopyScore = Number(from.minCopyScore);
  return filters;
}

/**
 * Create a congress strategy from a backtest / research context.
 * Returns the strategy plus a routing warning when SIGNAL_ROUTING is still legacy.
 */
export function promoteStrategyFromResearch(body = {}) {
  const kind = body.from?.kind || body.kind || 'congress-backtest';
  if (kind === 'tweet' || kind === 'youtube' || kind === 'tweet-backtest' || kind === 'youtube-backtest') {
    throw new Error('Promote is only available for congress and strategy backtests');
  }

  let filters;
  if (kind === 'strategy' || kind === 'strategy-backtest') {
    const strategyId = Number(body.from?.strategyId ?? body.strategyId);
    if (!Number.isFinite(strategyId)) throw new Error('strategyId is required to promote a strategy backtest');
    const existing = getStrategy(strategyId);
    if (!existing) throw new Error(`strategy ${strategyId} not found`);
    filters = existing.definition.filters || {};
  } else {
    filters = promoteFiltersFromBody(body);
    if (!filters.politicians?.length && !filters.minCopyScore && !filters.sectors?.length) {
      throw new Error('promote requires politicians (or other filters) derived from the backtest');
    }
  }

  const mode = body.mode || body.action?.mode || 'manual';
  const fund = body.fund || body.action?.fund;
  if (!fund) throw new Error('fund is required');
  const notionalUsd = body.notionalUsd ?? body.action?.notionalUsd ?? body.from?.notionalPerTrade ?? 500;

  const definition = validateStrategyDefinition({
    source: 'congress',
    filters,
    action: { mode, fund, notionalUsd },
  });
  assertStrategyModeAllowed(definition.action);

  const name = String(body.name || '').trim()
    || (filters.politicians?.length === 1
      ? `Copy ${filters.politicians[0]}`
      : `Promoted ${kind} ${new Date().toISOString().slice(0, 10)}`);

  const strategy = createStrategy({
    name,
    enabled: body.enabled !== false,
    definition,
  });

  const routing = config.signals.routing;
  const routingWarning = routing !== 'strategies'
    ? 'SIGNAL_ROUTING is not "strategies" — this strategy will not receive live congress trades until you set SIGNAL_ROUTING=strategies and restart.'
    : null;

  return { strategy, routing, routingWarning };
}
