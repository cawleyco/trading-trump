import cron from 'node-cron';
import { config } from '../config.js';
import { hasSeenCongressTrade, markCongressTradeSeen } from '../db.js';
import { makeTradeSignal } from '../signal.js';
import { processSignal } from '../riskManager.js';
import { archiveTrade, fetchRecentCongressTrades, tradeKey } from './congressData.js';
import { log } from '../logger.js';

let firstRun = true;

export async function pollCongressTrades() {
  let trades;
  try {
    trades = await fetchRecentCongressTrades();
  } catch (err) {
    log.error('congress', `Failed to fetch congress trades: ${err.message}`);
    return;
  }

  const maxAgeMs = config.signals.congressMaxDisclosureAgeDays * 86400_000;
  let newCount = 0;

  for (const trade of trades) {
    const key = tradeKey(trade);

    // Archive every fetched trade (idempotent) before the dedup check — the
    // congress_trades table is the full-row archive; seen_congress_trades
    // keeps its exact dedup semantics.
    try {
      archiveTrade(trade);
    } catch (err) {
      log.error('congress', `Failed to archive trade ${key}: ${err.message}`);
    }

    if (hasSeenCongressTrade(key)) continue;
    markCongressTradeSeen(key);
    newCount++;

    // On the very first poll everything is "new" — seed the seen-table without
    // trading, otherwise startup would fire a signal for every recent disclosure.
    if (firstRun) continue;

    const disclosureAge = trade.disclosureDate
      ? Date.now() - new Date(trade.disclosureDate).getTime()
      : Infinity;
    if (disclosureAge > maxAgeMs) {
      log.info('congress', `Skipping stale disclosure: ${trade.politician} ${trade.type} ${trade.ticker} (disclosed ${trade.disclosureDate})`);
      continue;
    }

    try {
      const signal = makeTradeSignal({
        source: 'congress',
        ticker: trade.ticker,
        direction: trade.type,
        rationale: `${trade.politician} disclosed ${trade.type} of ${trade.ticker} ` +
          `(traded ${trade.transactionDate}, disclosed ${trade.disclosureDate}, range ${trade.amountRange})`,
        rawReference: trade.raw,
        eventTimestamp: trade.disclosureDate,
      });
      await processSignal(signal);
    } catch (err) {
      log.error('congress', `Failed to process trade ${key}: ${err.message}`);
    }
  }

  log.info('congress', `Poll complete: ${trades.length} rows, ${newCount} new${firstRun ? ' (first run — seeded only, no trades placed)' : ''}`);
  firstRun = false;
}

export function startCongressPoller() {
  log.info('congress', `Starting congress poller (cron: ${config.polling.congressCron})`);
  pollCongressTrades();
  return cron.schedule(config.polling.congressCron, pollCongressTrades);
}
