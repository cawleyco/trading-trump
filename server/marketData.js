// Cached market-data helpers used by scoring, profiles, dashboards, and
// backtests.
//
// Two cache layers sit in front of the Alpaca client: an in-process Map
// (L1, 1-hour TTL, avoids re-parsing JSON in tight backtest loops) and the
// persistent compute_cache table (L2, survives restarts). Historical ranges
// (ending before today) are immutable and never expire in L2; ranges touching
// today keep the 1-hour TTL, and empty-but-successful results get 24 hours so
// a provider hiccup cannot poison the cache forever.
//
// Every function returns null (or []) on missing data — a bad ticker must
// never throw. The Alpaca client is imported lazily so the pure math helpers
// (_computeDrift, _computeAdv, _firstCloseOnOrAfter, _barsTtl) stay
// unit-testable without broker config.

import { log } from './logger.js';
import { defaultCache } from './cache/computeCache.js';

export const BARS_VERSION = 1; // bump when the cached bar shape changes

const CACHE_TTL_MS = 3600_000;
const EMPTY_TTL_MS = 86_400_000;
const cache = new Map(); // key → { value, at }

function getCached(key) {
  const hit = cache.get(key);
  return hit && Date.now() - hit.at < CACHE_TTL_MS ? hit : null;
}

function setCached(key, value) {
  cache.set(key, { value, at: Date.now() });
  return value;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(isoDate, days) {
  return new Date(new Date(`${isoDate}T00:00:00Z`).getTime() + days * 86400_000)
    .toISOString()
    .slice(0, 10);
}

/** L2 TTL for a daily range: immutable once the range ends before today. */
export function _barsTtl(endDate, nowMs = Date.now()) {
  const today = new Date(nowMs).toISOString().slice(0, 10);
  return String(endDate).slice(0, 10) < today ? null : CACHE_TTL_MS;
}

/** L2 TTL for a minute range: immutable once the range end is >24h old. */
export function _minuteBarsTtl(endIso, nowMs = Date.now()) {
  const endMs = new Date(endIso).getTime();
  return Number.isFinite(endMs) && endMs < nowMs - 86_400_000 ? null : CACHE_TTL_MS;
}

function ttlForResult(bars, rangeTtl) {
  return bars.length === 0 ? EMPTY_TTL_MS : rangeTtl;
}

/**
 * Daily OHLC bars between two dates (inclusive), ascending, as returned by
 * the Alpaca client. Returns null when the fetch fails or the ticker is
 * unknown; failures are never cached.
 */
export async function getDailyBarsCached(ticker, startDate, endDate) {
  if (!ticker || !startDate || !endDate) return null;
  const l1Key = `bars|${ticker}|${startDate}|${endDate}`;
  const l1 = getCached(l1Key);
  if (l1) return l1.value;
  const store = await defaultCache();
  const bars = await store.memoize(
    'bars:daily',
    { ticker, start: startDate, end: endDate },
    async () => {
      try {
        const { getDailyBars } = await import('./alpacaClient.js');
        return await getDailyBars(ticker, startDate, endDate);
      } catch (err) {
        log.warn('market-data', `getDailyBars(${ticker}, ${startDate}..${endDate}) failed: ${err.message}`);
        return null;
      }
    },
    {
      version: BARS_VERSION,
      ttlMs: (bars) => ttlForResult(bars, _barsTtl(endDate)),
      shouldCache: Array.isArray,
    }
  );
  return Array.isArray(bars) ? setCached(l1Key, bars) : null;
}

/**
 * Minute bars between two ISO timestamps, ascending. Returns null when the
 * fetch fails; failures are never cached.
 */
export async function getMinuteBarsCached(ticker, startIso, endIso) {
  if (!ticker || !startIso || !endIso) return null;
  const l1Key = `mbars|${ticker}|${startIso}|${endIso}`;
  const l1 = getCached(l1Key);
  if (l1) return l1.value;
  const store = await defaultCache();
  const bars = await store.memoize(
    'bars:minute',
    { ticker, start: startIso, end: endIso },
    async () => {
      try {
        const { getMinuteBars } = await import('./alpacaClient.js');
        return await getMinuteBars(ticker, startIso, endIso);
      } catch (err) {
        log.warn('market-data', `getMinuteBars(${ticker}, ${startIso}..${endIso}) failed: ${err.message}`);
        return null;
      }
    },
    {
      version: BARS_VERSION,
      ttlMs: (bars) => ttlForResult(bars, _minuteBarsTtl(endIso)),
      shouldCache: Array.isArray,
    }
  );
  return Array.isArray(bars) ? setCached(l1Key, bars) : null;
}

/**
 * Daily bars between two dates (inclusive) as [{date, open, close, volume}],
 * ascending. Returns null when the fetch fails or the ticker is unknown.
 */
export async function getDailyCloses(ticker, startDate, endDate) {
  const bars = await getDailyBarsCached(ticker, startDate, endDate);
  return bars
    ? bars.map((b) => ({ date: b.date, open: b.open, close: b.close, volume: b.volume ?? null }))
    : null;
}

/** Close of the first trading day on or after `date`, or null. */
export function _firstCloseOnOrAfter(bars, date) {
  const bar = (bars || []).find((b) => b.date >= date && b.close != null);
  return bar ? bar.close : null;
}

export async function priceOn(ticker, date) {
  if (!date) return null;
  const bars = await getDailyCloses(ticker, date, addDays(date, 14));
  return _firstCloseOnOrAfter(bars, date);
}

/** Most recent daily close, or null. */
export async function latestPrice(ticker) {
  const end = todayIso();
  const bars = await getDailyCloses(ticker, addDays(end, -14), end);
  if (!bars || bars.length === 0) return null;
  return bars[bars.length - 1].close ?? null;
}

export function _computeDrift(fromPrice, toPrice) {
  if (fromPrice == null || toPrice == null || fromPrice === 0) return null;
  return ((toPrice - fromPrice) / fromPrice) * 100;
}

/** Percent change from the close on/after sinceDate to the latest close. */
export async function driftSincePct(ticker, sinceDate) {
  const [from, to] = await Promise.all([priceOn(ticker, sinceDate), latestPrice(ticker)]);
  return _computeDrift(from, to);
}

export function _computeAdv(bars, days = 20) {
  const usable = (bars || [])
    .filter((b) => b.close != null && b.volume != null)
    .slice(-days);
  if (usable.length === 0) return null;
  return usable.reduce((sum, b) => sum + b.close * b.volume, 0) / usable.length;
}

/** Mean close×volume over the last `days` bars, or null. */
export async function avgDollarVolume(ticker, days = 20) {
  const end = todayIso();
  // ~2 calendar days per trading day, plus slack for holidays
  const bars = await getDailyCloses(ticker, addDays(end, -(days * 2 + 10)), end);
  return _computeAdv(bars, days);
}
