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
  getCreatorAlpha,
} from '../db.js';
import { enabledFunds } from '../config.js';
import { getFundClient } from '../alpacaClient.js';
import { buildThesisCard } from './thesisCard.js';
import { confluenceSourcesForTicker } from './confluence.js';
import { mentionAlertMessage } from '../influence/mentionCard.js';
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
    case 'creator-alpha-mention': {
      if (event.kind !== 'youtube-mention') return null;
      // Trust layer enforced at the alert boundary: a null alpha (below the
      // minimum sample) never fires, however good the mention looks.
      if (event.alpha?.label !== 'follow' || event.alpha?.alpha_score == null) return null;
      if (!(Number(event.alpha.alpha_score) >= Number(p.minAlpha ?? 65))) return null;
      if (!(Number(event.mention.mention_quality_score ?? 0) >= Number(p.minQuality ?? 70))) return null;
      return {
        dedupKey: `cam:${rule.id}:${event.mention.id}`,
        title: `Proven-alpha mention: ${event.mention.symbol}`,
        message: mentionAlertMessage(event.mention, event.alpha),
      };
    }
    case 'pump-warning': {
      if (event.kind !== 'youtube-mention') return null;
      if (!(Number(event.mention.pump_risk_score ?? 0) >= Number(p.minPumpRisk ?? 70))) return null;
      const symbol = String(event.mention.symbol || '').toUpperCase();
      const held = event.heldTickers?.has(symbol);
      const watched = event.watchMatches?.length > 0;
      if (!held && !watched) return null; // only warn about what you hold or watch
      return {
        dedupKey: `pw:${rule.id}:${event.mention.id}`,
        title: `Pump warning: ${symbol}${held ? ' (HELD)' : ''}`,
        message: mentionAlertMessage(event.mention, event.alpha),
      };
    }
    case 'fade-candidate-mention': {
      if (event.kind !== 'youtube-mention') return null;
      if (event.alpha?.label !== 'fade') return null;
      const held = event.heldTickers?.has(String(event.mention.symbol || '').toUpperCase());
      const watched = event.watchMatches?.length > 0;
      if (!held && !watched) return null;
      return {
        dedupKey: `fc:${rule.id}:${event.mention.id}`,
        title: `Fade-candidate mention: ${event.mention.symbol}`,
        message: mentionAlertMessage(event.mention, event.alpha),
      };
    }
    case 'confluence': {
      if (event.kind !== 'trade-scored' && event.kind !== 'youtube-mention') return null;
      const sources = event.confluenceSources || [];
      const minSources = Number(p.minSources ?? 2);
      if (sources.length < minSources) return null;
      const ticker = event.kind === 'trade-scored'
        ? String(event.trade.ticker).toUpperCase()
        : String(event.mention.symbol).toUpperCase();
      const eventDay = event.kind === 'trade-scored'
        ? event.trade.disclosure_date
        : String(event.mention.event_time || '').slice(0, 10);
      // Week-bucketed dedup: one confluence alert per ticker per week, however
      // many individual events land inside the window.
      const weekBucket = Math.floor(new Date(`${eventDay}T00:00:00Z`).getTime() / (7 * 86400_000));
      return {
        dedupKey: `cf:${rule.id}:${ticker}:${weekBucket}`,
        title: `Confluence: ${ticker}`,
        message: oneLine(
          `${sources.length} independent sources (${sources.join(', ')}) are active on ${ticker} ` +
            `within ${p.windowDays ?? 14} days. Latest: ${event.kind === 'trade-scored'
              ? tradeAlertMessage(event.trade, event.score)
              : mentionAlertMessage(event.mention, event.alpha)}`
        ),
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

const TRADE_TYPES = ['high-score-trade', 'committee-relevant', 'stale-warning', 'cluster', 'watchlist-activity', 'confluence'];

// Best-effort confluence lookup for a dispatch moment; never blocks the alert.
function safeConfluenceSources(ticker, onDay, windowDays = 14) {
  try {
    return confluenceSourcesForTicker(ticker, onDay, windowDays);
  } catch (err) {
    log.warn('alerts', `Confluence lookup failed for ${ticker}: ${err.message}`);
    return [];
  }
}

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
      confluenceSources: safeConfluenceSources(trade.ticker, trade.disclosure_date),
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

const YOUTUBE_TYPES = ['creator-alpha-mention', 'pump-warning', 'fade-candidate-mention', 'confluence'];

// Held tickers change slowly relative to mention volume — cache the Alpaca
// positions fan-out for a minute so a burst of mentions costs one API round.
// Exported for the morning digest's pump-warning section.
let _heldCache = { at: 0, tickers: new Set() };
export async function heldTickers() {
  if (Date.now() - _heldCache.at < 60_000) return _heldCache.tickers;
  const tickers = new Set();
  for (const fund of enabledFunds) {
    try {
      for (const p of await getFundClient(fund.name).getPositions()) {
        tickers.add(String(p.symbol).toUpperCase());
      }
    } catch (err) {
      log.warn('alerts', `Positions fetch failed for fund "${fund.name}": ${err.message}`);
    }
  }
  _heldCache = { at: Date.now(), tickers };
  return tickers;
}

/**
 * Called by the YouTube poller for each classified mention on a freshly
 * ingested video (never for backfill/first-run history). Best-effort.
 */
export async function dispatchYoutubeMention(mention, video, { notifyFn = notify } = {}) {
  try {
    const alpha = mention.channel_id ? getCreatorAlpha(mention.channel_id)[0] ?? null : null;
    const symbol = String(mention.symbol || '').toUpperCase();
    const watchMatches = listWatchlist().filter((w) => w.kind === 'ticker' && w.value === symbol);
    const event = {
      kind: 'youtube-mention',
      mention,
      video,
      alpha,
      watchMatches,
      heldTickers: await heldTickers(),
      confluenceSources: safeConfluenceSources(symbol, mention.event_time),
    };
    return runRules(event, YOUTUBE_TYPES, notifyFn);
  } catch (err) {
    log.warn('alerts', `dispatchYoutubeMention failed: ${err.message}`);
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
