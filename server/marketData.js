// Cached market-data helpers used by scoring, profiles, and dashboards.
//
// Wraps the shared Alpaca client with an in-memory cache (1-hour TTL). Every
// function returns null (or []) on missing data — a bad ticker must never
// throw. The Alpaca client is imported lazily so the pure math helpers
// (_computeDrift, _computeAdv, _firstCloseOnOrAfter) stay unit-testable
// without broker config.

import { log } from './logger.js';

const CACHE_TTL_MS = 3600_000;
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

/**
 * Daily bars between two dates (inclusive) as [{date, open, close, volume}],
 * ascending. Returns null when the fetch fails or the ticker is unknown.
 */
export async function getDailyCloses(ticker, startDate, endDate) {
  if (!ticker || !startDate || !endDate) return null;
  const key = `closes|${ticker}|${startDate}|${endDate}`;
  const hit = getCached(key);
  if (hit) return hit.value;
  try {
    const { getDailyBars } = await import('./alpacaClient.js');
    const bars = await getDailyBars(ticker, startDate, endDate);
    return setCached(
      key,
      bars.map((b) => ({ date: b.date, open: b.open, close: b.close, volume: b.volume ?? null }))
    );
  } catch (err) {
    log.warn('market-data', `getDailyCloses(${ticker}, ${startDate}..${endDate}) failed: ${err.message}`);
    return null; // failures are not cached — the next call retries
  }
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
