#!/usr/bin/env node
// Backfill the congress_trades archive from historical disclosures.
//
//   npm run backfill                              # 3 years back → today
//   npm run backfill -- --start 2024-01-01        # custom start
//   npm run backfill -- --start 2024-01-01 --end 2024-06-30
//
// Idempotent — rows are keyed by trade_key, so re-runs insert 0 new rows.
// Backfilled rows get first_seen_at = disclosure_date (best available
// estimate of publish time); live-poller rows carry a real first_seen_at.

import { db } from '../server/db.js';
import { archiveTrade, fetchHistoricalCongressTrades } from '../server/sources/congressData.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const today = new Date().toISOString().slice(0, 10);
const threeYearsBack = new Date(Date.now() - 3 * 365 * 86400_000).toISOString().slice(0, 10);
const start = arg('start', threeYearsBack);
const end = arg('end', today);

if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
  console.error('Dates must be YYYY-MM-DD');
  process.exit(1);
}

console.log(`Backfilling congress trades disclosed ${start} → ${end}...`);
const trades = await fetchHistoricalCongressTrades(start, end);
console.log(`Fetched ${trades.length} trades; upserting into congress_trades...`);

let inserted = 0;
let processed = 0;
for (const trade of trades) {
  const { isNew } = archiveTrade(trade, { firstSeenAt: trade.disclosureDate });
  if (isNew) inserted++;
  processed++;
  if (processed % 500 === 0) console.log(`  ${processed}/${trades.length} processed (${inserted} new)`);
}

const total = db.prepare(`SELECT COUNT(*) AS n FROM congress_trades`).get().n;
console.log(`Done: ${processed} fetched, ${inserted} new rows inserted, ${total} total in archive.`);
