// Filing data-quality assessment: how much do we trust a normalized congress
// trade, and what structured detail can we pull out of it?
//
// Pure module — the ticker resolver is injected so this stays offline and
// unit-testable. Amendment detection needs a DB lookup and lives in the
// caller (archiveTrade); everything else is here.

import { parseAmountRange } from './amountRange.js';

const OPTION_RE = /\b(call|put|option)s?\b/i;

/** Map a raw owner string from either source to self | spouse | dependent | null. */
export function normalizeOwner(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return null;
  if (s.includes('spouse') || s === 'sp') return 'spouse';
  if (s.includes('depend') || s.includes('child') || s === 'dc') return 'dependent';
  if (s.includes('self') || s.includes('joint') || s === 'jt') return 'self';
  return null;
}

/**
 * Inspect an asset description for option characteristics.
 * Returns { isOption, optionDetail, hasDetail } — hasDetail is true only when
 * a strike or expiry could actually be extracted (type alone isn't enough).
 */
export function detectOption(desc) {
  const text = String(desc || '');
  if (!OPTION_RE.test(text)) return { isOption: false, optionDetail: null, hasDetail: false };

  const type = /\bputs?\b/i.test(text) ? 'put' : /\bcalls?\b/i.test(text) ? 'call' : null;
  const strikeMatch = text.match(/\$\s?(\d+(?:\.\d+)?)/);
  const strike = strikeMatch ? Number(strikeMatch[1]) : null;
  const expiryMatch =
    text.match(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/) || text.match(/\b\d{4}-\d{2}-\d{2}\b/);
  const expiry = expiryMatch ? expiryMatch[0] : null;

  const detail = {};
  if (type) detail.type = type;
  if (strike != null) detail.strike = strike;
  if (expiry) detail.expiry = expiry;
  const hasDetail = strike != null || expiry != null;
  return {
    isOption: true,
    optionDetail: Object.keys(detail).length ? detail : null,
    hasDetail,
  };
}

function assetDescriptionOf(trade) {
  return (
    trade.assetDescription ??
    trade.raw?.assetName ??
    trade.raw?.Description ??
    trade.raw?.asset_description ??
    null
  );
}

/**
 * Assess a normalized trade. Returns:
 *   { parseConfidence, flags, owner, isOption, optionDetail, assetDescription }
 * parseConfidence starts at 1.0 and each detected issue subtracts and records
 * a flag string. `resolveTicker` is optional (injected); when omitted the
 * ticker-resolution check is skipped.
 */
export function assessTrade(trade, { resolveTicker } = {}) {
  const flags = [];
  let parseConfidence = 1.0;
  const assetDescription = assetDescriptionOf(trade);

  if (!trade.transactionDate) {
    parseConfidence -= 0.3;
    flags.push('missing-transaction-date');
  }

  if (parseAmountRange(trade.amountRange).mid == null) {
    parseConfidence -= 0.2;
    flags.push('no-amount');
  }

  if (resolveTicker && !resolveTicker(trade.ticker)) {
    parseConfidence -= 0.3;
    flags.push('unresolved-ticker');
  }

  const { isOption, optionDetail, hasDetail } = detectOption(assetDescription);
  if (isOption && !hasDetail) {
    parseConfidence -= 0.2;
    flags.push('unparsed-option');
  }

  if (
    trade.transactionDate &&
    trade.disclosureDate &&
    trade.disclosureDate < trade.transactionDate
  ) {
    parseConfidence -= 0.4;
    flags.push('date-inconsistency');
  }

  const owner = normalizeOwner(trade.raw?.owner ?? trade.raw?.Owner ?? trade.owner);

  // Clamp to [0,1] and round to avoid float noise (0.7999999…)
  parseConfidence = Math.max(0, Math.round(parseConfidence * 100) / 100);
  return { parseConfidence, flags, owner, isOption, optionDetail, assetDescription };
}
