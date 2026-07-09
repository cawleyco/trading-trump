// Phase 11 — alert rules engine.
//
// Rules live in the `alert_rules` table; each fires at a "natural moment" in the
// pipeline (a trade is scored, a strategy matches, a post is classified, the events
// collector runs). Every alert states the *why* — the message is built from the same
// deterministic detail strings as the thesis card — and is deduped via `alerts_sent`
// so the same subject never re-alerts.
//
// `evaluateRule(rule, event)` is pure and unit-testable; the dispatch* functions do
// the DB enrichment + fan-out and are best-effort (they never throw into the caller).

import {
  listAlertRules,
  recordAlertSent,
  listWatchlist,
  countClusterTrades,
  getTickerSector,
} from '../db.js';
import { buildThesisCard } from './thesisCard.js';
import { notify } from '../notifier.js';
import { log } from '../logger.js';

const STALE_CODES = ['stale-disclosure', 'freshness', 'disclosure-lag', 'low-freshness'];

function oneLine(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

/** Compact "why" one-liner for a scored trade, reusing the thesis-card detail strings. */
export function tradeAlertMessage(trade, score = {}) {
  const card = buildThesisCard(trade, score, {});
  const scoreStr = Number.isFinite(Number(score.score)) ? `[${Math.round(Number(score.score))}/100] ` : '';
  const why = card.whyItMatters?.[0] ? `${card.whyItMatters[0]} ` : '';
  const rec = card.suggestedAction || 'manual-review';
  return oneLine(`${scoreStr}${card.what} ${why}Recommendation: ${rec}.`);
}

function warningIsStale(warnings = []) {
  return warnings.some((w) => {
    const code = String(w?.code || '').toLowerCase();
    const msg = String(w?.message || '').toLowerCase();
    return STALE_CODES.some((c) => code.includes(c)) || msg.includes('stale') || msg.includes('disclosure lag');
  });
}

/**
 * Decide whether `rule` fires for `event`. Pure: `event` must already carry any
 * derived data the rule needs (sector, watchMatches, clusterCount). Returns
 * { dedupKey, title, message } when it fires, else null.
 */
export function evaluateRule(rule, event) {
  const p = rule.params || {};
  switch (rule.rule_type) {
    case 'high-score-trade': {
      if (event.kind !== 'trade-scored') return null;
      const min = Number(p.minScore ?? 80);
      if (!(Number(event.score?.score) >= min)) return null;
      return {
        dedupKey: `hs:${rule.id}:${event.trade.trade_key}`,
        title: 'High-score trade',
        message: tradeAlertMessage(event.trade, event.score),
      };
    }
    case 'committee-relevant': {
      if (event.kind !== 'trade-scored') return null;
      const factor = event.score?.factors?.committeeRelevance;
      const min = Number(p.minRelevance ?? 50);
      if (!factor?.hasData || !(Number(factor.score) >= min)) return null;
      return {
        dedupKey: `cr:${rule.id}:${event.trade.trade_key}`,
        title: 'Committee-relevant trade',
        message: tradeAlertMessage(event.trade, event.score),
      };
    }
    case 'stale-warning': {
      if (event.kind !== 'trade-scored') return null;
      if (!warningIsStale(event.score?.warnings)) return null;
      return {
        dedupKey: `sw:${rule.id}:${event.trade.trade_key}`,
        title: 'Stale-disclosure warning',
        message: tradeAlertMessage(event.trade, event.score),
      };
    }
    case 'cluster': {
      if (event.kind !== 'trade-scored') return null;
      const min = Number(p.clusterCount ?? 3);
      if (!(Number(event.clusterCount) >= min)) return null;
      return {
        dedupKey: `cl:${rule.id}:${event.trade.ticker}:${event.trade.type}:${event.trade.disclosure_date}`,
        title: 'Cluster trade',
        message: oneLine(
          `${event.clusterCount} members ${event.trade.type === 'sell' ? 'sold' : 'bought'} ${event.trade.ticker} ` +
            `within ${p.windowDays ?? 30} days. ${tradeAlertMessage(event.trade, event.score)}`
        ),
      };
    }
    case 'watchlist-activity': {
      const match = event.watchMatches?.[0];
      if (!match) return null;
      if (event.kind === 'trade-scored') {
        return {
          dedupKey: `wl:${rule.id}:${event.trade.trade_key}`,
          title: `Watchlist: ${match.value}`,
          message: tradeAlertMessage(event.trade, event.score),
        };
      }
      if (event.kind === 'calendar-event') {
        const ev = event.calendarEvent;
        return {
          dedupKey: `wle:${rule.id}:${ev.id}`,
          title: `Watchlist event: ${match.value}`,
          message: oneLine(`${ev.event_date}: ${ev.title}`),
        };
      }
      return null;
    }
    case 'strategy-match': {
      if (event.kind !== 'strategy-match') return null;
      return {
        dedupKey: `sm:${rule.id}:${event.strategy.id}:${event.trade.trade_key}`,
        title: `Strategy match: ${event.strategy.name}`,
        message: oneLine(`Strategy "${event.strategy.name}" matched. ${tradeAlertMessage(event.trade, event.score)}`),
      };
    }
    case 'tweet-catalyst': {
      if (event.kind !== 'post-classified') return null;
      const c = event.classification || {};
      const min = Number(p.minRelevance ?? 0);
      const relevant = c.marketRelevance === 'high' || c.marketRelevance === 'medium' ||
        (Number.isFinite(Number(c.marketRelevance)) && Number(c.marketRelevance) >= min);
      if (!relevant) return null;
      const tickers = (c.tickers || []).map((t) => t.ticker).filter(Boolean);
      return {
        dedupKey: `tc:${rule.id}:${event.post.id}`,
        title: 'Tweet catalyst',
        message: oneLine(
          `Market-relevant post (${c.relevanceType || 'catalyst'}${tickers.length ? `, ${tickers.join(', ')}` : ''}): ` +
            `"${String(event.post.text || '').slice(0, 160)}"`
        ),
      };
    }
    default:
      return null;
  }
}

// --- runtime dispatch ---------------------------------------------------------

const TRADE_TYPES = ['high-score-trade', 'committee-relevant', 'stale-warning', 'cluster', 'watchlist-activity'];

function runRules(event, applicableTypes, notifyFn) {
  const rules = listAlertRules({ includeDisabled: false }).filter((r) => applicableTypes.includes(r.rule_type));
  const fired = [];
  for (const rule of rules) {
    let res = null;
    try {
      res = evaluateRule(rule, event);
    } catch (err) {
      log.warn('alerts', `Rule ${rule.id} (${rule.rule_type}) evaluation failed: ${err.message}`);
    }
    if (!res) continue;
    const isNew = recordAlertSent({ ruleId: rule.id, dedupKey: res.dedupKey, message: res.message });
    if (!isNew) continue; // already alerted for this subject
    try {
      notifyFn(res.title, res.message, { channel: rule.channel });
    } catch (err) {
      log.warn('alerts', `Notify failed for rule ${rule.id}: ${err.message}`);
    }
    fired.push({ ruleId: rule.id, ...res });
  }
  return fired;
}

function watchMatchesForTrade(trade, sector) {
  const watched = listWatchlist();
  const matches = [];
  for (const w of watched) {
    if (w.kind === 'ticker' && w.value === String(trade.ticker).toUpperCase()) matches.push(w);
    else if (w.kind === 'politician' && w.value === trade.politician) matches.push(w);
    else if (w.kind === 'sector' && sector && w.value === sector) matches.push(w);
  }
  return matches;
}

/** Called after a newly-seen congress trade is scored. Best-effort. */
export function dispatchTradeScored(trade, score, { notifyFn = notify } = {}) {
  try {
    const sector = getTickerSector(trade.ticker);
    const clusterCount = countClusterTrades({
      ticker: trade.ticker,
      type: trade.type,
      disclosureDate: trade.disclosure_date,
    });
    const event = {
      kind: 'trade-scored',
      trade,
      score,
      sector,
      clusterCount,
      watchMatches: watchMatchesForTrade(trade, sector),
    };
    return runRules(event, TRADE_TYPES, notifyFn);
  } catch (err) {
    log.warn('alerts', `dispatchTradeScored failed: ${err.message}`);
    return [];
  }
}

/** Called after a strategy matches a trade. Best-effort. */
export function dispatchStrategyMatch(strategy, trade, score, { notifyFn = notify } = {}) {
  try {
    return runRules({ kind: 'strategy-match', strategy, trade, score }, ['strategy-match'], notifyFn);
  } catch (err) {
    log.warn('alerts', `dispatchStrategyMatch failed: ${err.message}`);
    return [];
  }
}

/** Called after a truth-social post is classified (non-seed posts only). Best-effort. */
export function dispatchPostClassified(post, classification, { notifyFn = notify } = {}) {
  try {
    return runRules({ kind: 'post-classified', post, classification }, ['tweet-catalyst'], notifyFn);
  } catch (err) {
    log.warn('alerts', `dispatchPostClassified failed: ${err.message}`);
    return [];
  }
}

/** Called after the events collector runs, once per upcoming event. Best-effort. */
export function dispatchCalendarEvents(events = [], { notifyFn = notify } = {}) {
  const watched = listWatchlist();
  const watchedSectors = new Set(watched.filter((w) => w.kind === 'sector').map((w) => w.value));
  const watchedCommittees = new Set(watched.filter((w) => w.kind === 'committee').map((w) => w.value));
  if (!watchedSectors.size && !watchedCommittees.size) return [];
  const fired = [];
  for (const ev of events) {
    const matches = [];
    for (const s of ev.sectors || []) if (watchedSectors.has(s)) matches.push({ kind: 'sector', value: s });
    if (ev.committee_id && watchedCommittees.has(ev.committee_id)) matches.push({ kind: 'committee', value: ev.committee_id });
    if (!matches.length) continue;
    try {
      fired.push(...runRules({ kind: 'calendar-event', calendarEvent: ev, watchMatches: matches }, ['watchlist-activity'], notifyFn));
    } catch (err) {
      log.warn('alerts', `dispatchCalendarEvents failed for event ${ev.id}: ${err.message}`);
    }
  }
  return fired;
}
