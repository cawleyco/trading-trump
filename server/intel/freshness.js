// Freshness / lag metrics for a congress trade.
//
// Pure functions — no I/O. Callers pass archive rows (snake_case, from
// congress_trades) or normalized trades (camelCase); both field styles are
// accepted. All functions are null-safe and return null when a required date
// is missing. This is the first module of the intelligence layer; everything
// under server/intel/ is deterministic and unit-testable.

const DAY_MS = 86400_000;

/** Parse 'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM:SS' (SQLite datetime) as UTC. */
function parseDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'string' || !value.trim()) return null;
  let s = value.trim().replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += 'T00:00:00';
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) s += 'Z';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Whole days from `from` to `to` (floored), or null if either is unparseable. */
function daysBetween(from, to) {
  const a = parseDate(from);
  const b = parseDate(to);
  if (!a || !b) return null;
  return Math.floor((b.getTime() - a.getTime()) / DAY_MS);
}

const txnDate = (t) => t.transaction_date ?? t.transactionDate ?? null;
const discDate = (t) => t.disclosure_date ?? t.disclosureDate ?? null;
const firstSeen = (t) => t.first_seen_at ?? t.firstSeenAt ?? null;

/** Days between the trade and its disclosure (the STOCK Act reporting lag). */
export function disclosureLagDays(trade) {
  return daysBetween(txnDate(trade), discDate(trade));
}

/** Days between the trade and when WE first saw it (true copy-trading lag). */
export function publishLagDays(trade) {
  return daysBetween(txnDate(trade), firstSeen(trade));
}

/** Days since we first saw the trade. */
export function ageDays(trade, now = new Date()) {
  return daysBetween(firstSeen(trade), now);
}

/**
 * Freshness 0–100 from the total lag transaction→now: 100 when ≤ 5 days,
 * linear down to 0 at 60 days. Falls back to the disclosure date as the
 * anchor when the transaction date is missing. Returns
 * { score, lagDays, ageDays, basis } — basis is 'transaction' | 'disclosure',
 * or null (with score null) when no usable date exists.
 */
export function freshnessScore(trade, now = new Date()) {
  const nowDate = parseDate(now) || new Date();
  let basis = 'transaction';
  let anchor = txnDate(trade);
  if (!anchor) {
    basis = 'disclosure';
    anchor = discDate(trade);
  }
  if (!anchor) {
    return { score: null, lagDays: null, ageDays: ageDays(trade, nowDate), basis: null };
  }

  const lagDays = daysBetween(anchor, nowDate);
  let score;
  if (lagDays <= 5) score = 100;
  else if (lagDays >= 60) score = 0;
  else score = Math.round((100 * (60 - lagDays)) / (60 - 5));

  return { score, lagDays, ageDays: ageDays(trade, nowDate), basis };
}
