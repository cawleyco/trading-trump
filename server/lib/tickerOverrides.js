// Manual company-name → ticker overrides, plus the resolution precedence.
//
// Filings and lobbying/contract records name companies inconsistently; the
// SEC name match handles most, but some well-known names need pinning (e.g.
// "Alphabet Inc" could match either share class). Overrides win over every
// other lookup. Extend this map as unresolved names show up in the logs.

const OVERRIDES = {
  'alphabet': 'GOOGL',
  'alphabet inc': 'GOOGL',
  'google': 'GOOGL',
  'meta platforms': 'META',
  'meta platforms inc': 'META',
  'facebook': 'META',
  'berkshire hathaway': 'BRK.B',
  'berkshire hathaway inc': 'BRK.B',
};

function normalizeName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[.,]/g, '')
    .replace(/\s+/g, ' ');
}

/** Manual override for a company name, or null. */
export function overrideFor(nameOrTicker) {
  return OVERRIDES[normalizeName(nameOrTicker)] ?? null;
}

/**
 * Resolution precedence shared by tickerMeta.resolveTicker (and unit-tested
 * without a database): manual override → exact ticker match → company-name
 * match. Lookups are injected; each returns a ticker string or null.
 */
export function resolveWithPrecedence(nameOrTicker, { byTicker, byName }) {
  const input = String(nameOrTicker || '').trim();
  if (!input) return null;
  const override = overrideFor(input);
  if (override) return override;
  const exact = byTicker(input.toUpperCase());
  if (exact) return exact;
  return byName(input) ?? null;
}
