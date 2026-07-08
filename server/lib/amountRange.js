// STOCK Act disclosure amount bands → numbers.
//
// Filings report dollar amounts as ranges ("$15,001 - $50,000"), sometimes
// open-ended ("Over $50,000,000", "$1,000,000 +") or truncated ("$1,001 -").

const EMPTY = { min: null, max: null, mid: null };

/**
 * Parse an amount band string into { min, max, mid }.
 * - "$15,001 - $50,000"  → { min: 15001, max: 50000, mid: 32500.5 }
 * - "Over $50,000,000"   → { min: 50000000, max: null, mid: min * 1.5 }
 * - "$1,001 -"           → { min: 1001, max: null, mid: min * 1.5 }
 * - garbage / null       → all nulls
 */
export function parseAmountRange(input) {
  if (typeof input !== 'string' || !input.trim()) return { ...EMPTY };
  const text = input.trim();

  const numbers = [...text.matchAll(/\$?\s*(\d[\d,]*(?:\.\d+)?)/g)]
    .map((m) => Number(m[1].replace(/,/g, '')))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (numbers.length === 0) return { ...EMPTY };

  if (numbers.length >= 2) {
    const [min, max] = numbers;
    if (max < min) return { ...EMPTY };
    return { min, max, mid: (min + max) / 2 };
  }

  const min = numbers[0];
  const openEnded = /\bover\b/i.test(text) || /\+\s*$/.test(text) || /-\s*$/.test(text);
  if (openEnded) return { min, max: null, mid: min * 1.5 };
  // A single bare number is treated as an exact amount
  return { min, max: min, mid: min };
}
