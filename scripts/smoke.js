#!/usr/bin/env node
// End-to-end smoke test of the intelligence pipeline (Phase 12.3).
//
//   npm run smoke
//
// Runs the whole chain against your real data and prints PASS/FAIL per step:
//   1. ingest recent Congress trades   2. verify data-quality fields
//   3. score a trade                   4. build its thesis card
//   5. evaluate a seed strategy        6. create a manual approval (dry-run)
//   7. approve it via the HTTP API     8. verify the audit chain is complete
//
// Needs the usual keys (Alpaca for prices, optional Quiver) AND the server
// running (steps 7–8 hit http://127.0.0.1:PORT). It is safe: the manual-approval
// path in dry_run only records a simulated order — nothing is sent to a broker.
// Not part of `npm test` (it needs network + a live server).

import { config, enabledFunds } from '../server/config.js';
import { archiveTrade, fetchRecentCongressTrades } from '../server/sources/congressData.js';
import {
  listCongressTrades,
  createStrategy,
  deleteStrategy,
  updateStrategy,
  listPendingApprovals,
} from '../server/db.js';
import { scoreTrade } from '../server/intel/scoreRunner.js';
import { getOrBuildThesisCard } from '../server/intel/cardRunner.js';
import { processTradeThroughStrategies } from '../server/intel/strategyEngine.js';

const BASE = `http://127.0.0.1:${config.port}`;

let passed = 0;
let failed = 0;
function pass(step, detail = '') {
  passed++;
  console.log(`  \x1b[32mPASS\x1b[0m ${step}${detail ? ` — ${detail}` : ''}`);
}
function fail(step, detail = '') {
  failed++;
  console.log(`  \x1b[31mFAIL\x1b[0m ${step}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  console.log(`\nIntelligence pipeline smoke test (mode=${config.tradingMode}, server=${BASE})\n`);

  // --- 1. Ingest ------------------------------------------------------------
  let fetched = [];
  try {
    fetched = await fetchRecentCongressTrades();
    let archived = 0;
    for (const t of fetched) {
      try { archiveTrade(t); archived++; } catch { /* skip bad row */ }
    }
    if (archived === 0) throw new Error('fetched trades but archived none');
    pass('1. ingest recent trades', `${fetched.length} fetched, ${archived} archived`);
  } catch (err) {
    fail('1. ingest recent trades', err.message);
  }

  // Pick a workable trade: recent, high parse confidence, not an option.
  const candidates = listCongressTrades({ limit: 200 })
    .filter((t) => (t.parse_confidence ?? 1) >= 0.8 && !t.is_option);
  const trade = candidates[0];
  if (!trade) {
    fail('pick a candidate trade', 'no archived trade with parse_confidence ≥ 0.8 — cannot continue');
    return finish();
  }
  console.log(`  … using ${trade.trade_key}\n`);

  // --- 2. Quality fields ----------------------------------------------------
  const qualityOk = typeof trade.parse_confidence === 'number' &&
    trade.ticker && trade.type && ('amount_mid' in trade);
  qualityOk
    ? pass('2. verify quality fields', `parse_confidence=${trade.parse_confidence}`)
    : fail('2. verify quality fields', 'missing parse_confidence/ticker/type/amount');

  // --- 3. Score -------------------------------------------------------------
  let score = null;
  try {
    score = await scoreTrade(trade.trade_key, { force: true });
    if (!Number.isFinite(Number(score.score)) || !score.recommendation) throw new Error('score/recommendation missing');
    pass('3. score the trade', `${score.score}/100 → ${score.recommendation}`);
  } catch (err) {
    fail('3. score the trade', err.message);
  }

  // --- 4. Thesis card -------------------------------------------------------
  try {
    const card = await getOrBuildThesisCard(trade.trade_key);
    if (!card?.card?.what) throw new Error('card missing "what" section');
    pass('4. build thesis card', card.card.what.slice(0, 60) + '…');
  } catch (err) {
    fail('4. build thesis card', err.message);
  }

  // --- 5 & 6. Seed strategy + manual approval -------------------------------
  const fund = enabledFunds[0]?.name || 'default';
  const stratName = `smoke-${Date.now()}`;
  let strategyId = null;
  let approval = null;
  try {
    const strat = createStrategy({
      name: stratName,
      enabled: true,
      // Empty filters match any trade; manual mode routes to the approval queue.
      definition: { source: 'congress', filters: {}, action: { mode: 'manual', fund, notionalUsd: 100 } },
    });
    strategyId = strat.id;
    const results = await processTradeThroughStrategies(trade.trade_key, { score });
    const matched = results.find((r) => r.strategyId === strategyId && r.matched);
    if (!matched) throw new Error('seed strategy did not match the trade');
    pass('5. evaluate seed strategy', `matched, outcome=${matched.outcome}`);

    approval = listPendingApprovals('pending', 100).find(
      (a) => a.strategy_id === strategyId && a.trade_key === trade.trade_key
    );
    approval
      ? pass('6. create manual approval', `approval #${approval.id}`)
      : fail('6. create manual approval', 'no pending approval was created');
  } catch (err) {
    fail('5. evaluate seed strategy', err.message);
  }

  // --- 7. Approve via the HTTP API ------------------------------------------
  let signalId = null;
  if (approval) {
    try {
      const resp = await fetch(`${BASE}/api/approvals/${approval.id}/approve`, { method: 'POST' });
      const body = await resp.json();
      if (!resp.ok) throw new Error(body.error || `HTTP ${resp.status}`);
      signalId = body.signalId;
      if (!signalId) throw new Error('approval succeeded but returned no signalId');
      pass('7. approve via API', `signal #${signalId}`);
    } catch (err) {
      fail('7. approve via API', /fetch failed|ECONNREFUSED/.test(err.message) ? `server not reachable at ${BASE} — start it with "npm start"` : err.message);
    }
  } else {
    fail('7. approve via API', 'skipped — no approval to approve');
  }

  // --- 8. Audit chain -------------------------------------------------------
  if (signalId != null) {
    try {
      const resp = await fetch(`${BASE}/api/audit/signal/${signalId}`);
      const audit = await resp.json();
      if (!resp.ok) throw new Error(audit.error || `HTTP ${resp.status}`);
      const complete = audit.signal && Array.isArray(audit.decisions) && audit.decisions.length > 0;
      complete
        ? pass('8. verify audit chain', `signal + ${audit.decisions.length} decision(s)`)
        : fail('8. verify audit chain', 'audit document is incomplete');
    } catch (err) {
      fail('8. verify audit chain', err.message);
    }
  } else {
    fail('8. verify audit chain', 'skipped — no signal id');
  }

  // --- cleanup --------------------------------------------------------------
  // Once the strategy has a match/approval, FK constraints block deletion — so
  // fall back to disabling it, which stops it matching future trades.
  if (strategyId != null) {
    try {
      deleteStrategy(strategyId);
    } catch {
      try { updateStrategy(strategyId, { enabled: false }); } catch { /* best effort */ }
    }
  }

  finish();
}

function finish() {
  const total = passed + failed;
  console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed}/${total} steps passed\x1b[0m\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('smoke test crashed:', err);
  process.exit(1);
});
