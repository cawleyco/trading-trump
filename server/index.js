import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { config, enabledFunds } from './config.js';
import {
  listSignalsWithDecisions,
  getDailyPnl,
  getActiveKillSwitchEvent,
  recordKillSwitchTrip,
  resetKillSwitch,
  listBacktests,
  getBacktest,
  listReviewQueue,
  resolveReviewItem,
} from './db.js';
import { fundClients, getFundClient } from './alpacaClient.js';
import {
  isFundHalted,
  fundHaltReason,
  isGloballyHalted,
  refreshAllFundsPnl,
  processSignal,
} from './riskManager.js';
import { makeTradeSignal } from './signal.js';
import { notify } from './notifier.js';
import { startCongressPoller } from './sources/congressPoller.js';
import { startTruthSocialPoller } from './sources/truthSocialPoller.js';
import { ensureTickerUniverse } from './sources/tickerMeta.js';
import { startPositionManager } from './positionManager.js';
import { runCongressBacktest, runCongressLeaderboard, listPoliticians } from './backtest/congressBacktest.js';
import { runTweetBacktest } from './backtest/tweetBacktest.js';
import { getAttribution } from './attribution.js';
import { log } from './logger.js';

const app = express();
app.use(express.json());

function todayEt() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// ---------- status ----------
app.get('/api/status', async (req, res) => {
  const tradeDate = todayEt();
  const fundStatuses = await Promise.all(
    enabledFunds.map(async (fund) => {
      const base = {
        name: fund.name,
        paper: fund.paper,
        sources: fund.sources,
        risk: fund.risk,
        sentimentConfidenceThreshold: fund.sentimentConfidenceThreshold,
        autoExit: fund.autoExit,
        halted: isFundHalted(fund.name),
        haltReason: fundHaltReason(fund.name),
        killSwitchEvent: getActiveKillSwitchEvent(fund.name) || null,
        dailyPnl: getDailyPnl(tradeDate, fund.name) || null,
      };
      try {
        const client = getFundClient(fund.name);
        const [account, positions] = await Promise.all([client.getAccount(), client.getPositions()]);
        return {
          ...base,
          equity: Number(account.equity),
          buyingPower: Number(account.buying_power),
          positions: positions.map((p) => ({
            symbol: p.symbol,
            qty: Number(p.qty),
            marketValue: Number(p.market_value),
            unrealizedPl: Number(p.unrealized_pl),
            avgEntry: Number(p.avg_entry_price),
          })),
        };
      } catch (err) {
        return { ...base, error: err.message, equity: null, positions: [] };
      }
    })
  );
  res.json({
    tradingMode: config.tradingMode,
    globallyHalted: isGloballyHalted(),
    funds: fundStatuses,
  });
});

// ---------- signals / decisions log ----------
app.get('/api/signals', (req, res) => {
  res.json(listSignalsWithDecisions(Number(req.query.limit) || 100));
});

// ---------- kill switches (per fund; omit fund = all) ----------
app.post('/api/halt', async (req, res) => {
  const fundName = req.body?.fund || null;
  const reason = `manual halt from dashboard: ${req.body?.reason || 'no reason given'}`;
  const targets = fundName ? enabledFunds.filter((f) => f.name === fundName) : enabledFunds;
  if (targets.length === 0) return res.status(404).json({ error: `unknown fund "${fundName}"` });

  for (const fund of targets) {
    recordKillSwitchTrip(reason, fund.name);
    try {
      await getFundClient(fund.name).cancelAllOrders();
    } catch (err) {
      log.error('server', `[${fund.name}] cancelAllOrders on manual halt failed: ${err.message}`);
    }
    log.warn('server', `[${fund.name}] MANUAL HALT engaged from dashboard`);
  }
  notify('Trading halted', fundName ? `Fund "${fundName}" halted from dashboard` : 'ALL funds halted from dashboard');
  res.json({ halted: targets.map((f) => f.name) });
});

app.post('/api/resume', (req, res) => {
  const fundName = req.body?.fund || null;
  resetKillSwitch(fundName);
  if (!fundName && fs.existsSync(config.haltFilePath)) fs.unlinkSync(config.haltFilePath);
  log.warn('server', `Trading resumed from dashboard (${fundName || 'all funds'})`);
  res.json({ resumed: fundName || 'all' });
});

// ---------- manual test signal (pipeline check) ----------
app.post('/api/test-signal', async (req, res) => {
  try {
    const signal = makeTradeSignal({
      source: req.body.source || 'congress',
      ticker: req.body.ticker,
      direction: req.body.direction || 'buy',
      confidence: req.body.confidence ?? 0.99,
      rationale: 'manual test signal from dashboard',
      rawReference: { manual: true },
    });
    res.json(await processSignal(signal, { onlyFund: req.body.fund || undefined }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- data-quality review queue ----------
app.get('/api/review-queue', (req, res) => {
  const status = req.query.status || 'pending';
  const rows = listReviewQueue(status).map((r) => {
    let raw = null;
    try { raw = r.raw ? JSON.parse(r.raw) : null; } catch { /* leave null */ }
    return { ...r, raw };
  });
  res.json(rows);
});

app.post('/api/review-queue/:id/resolve', (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'numeric id required' });
  const status = req.body?.status;
  if (!['approved', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'status must be "approved" or "rejected"' });
  }
  const ok = resolveReviewItem(Number(req.params.id), status);
  if (!ok) return res.status(404).json({ error: 'no pending review item with that id' });
  res.json({ id: Number(req.params.id), status });
});

// ---------- P&L attribution ----------
app.get('/api/attribution', (req, res) => {
  try {
    res.json(getAttribution());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- backtests ----------
app.get('/api/backtests', (req, res) => res.json(listBacktests()));

app.get('/api/backtests/:id', (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'numeric id required' });
  const bt = getBacktest(Number(req.params.id));
  if (!bt) return res.status(404).json({ error: 'not found' });
  res.json(bt);
});

app.get('/api/politicians', async (req, res) => {
  try {
    res.json(await listPoliticians());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/backtests/congress', async (req, res) => {
  try {
    const { politician, startDate, endDate, notionalPerTrade, exitRule, stopLossPct, takeProfitPct } = req.body;
    if (!politician || !startDate || !endDate || !notionalPerTrade) {
      return res.status(400).json({ error: 'politician, startDate, endDate, notionalPerTrade required' });
    }
    res.json(
      await runCongressBacktest({
        politician,
        startDate,
        endDate,
        notionalPerTrade: Number(notionalPerTrade),
        exitRule,
        stopLossPct: stopLossPct ? Number(stopLossPct) : null,
        takeProfitPct: takeProfitPct ? Number(takeProfitPct) : null,
      })
    );
  } catch (err) {
    log.error('server', `Congress backtest failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/backtests/congress-leaderboard', async (req, res) => {
  try {
    const { startDate, endDate, notionalPerTrade, exitRule, minTrades } = req.body;
    if (!startDate || !endDate || !notionalPerTrade) {
      return res.status(400).json({ error: 'startDate, endDate, notionalPerTrade required' });
    }
    res.json(
      await runCongressLeaderboard({
        startDate,
        endDate,
        notionalPerTrade: Number(notionalPerTrade),
        exitRule,
        minTrades: minTrades ? Number(minTrades) : 3,
      })
    );
  } catch (err) {
    log.error('server', `Leaderboard backtest failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/backtests/tweet', async (req, res) => {
  try {
    const { startDate, endDate, notionalPerTrade, holdDays, holdHours, confidenceThreshold, maxPosts, stopLossPct, takeProfitPct } = req.body;
    if (!startDate || !endDate || !notionalPerTrade) {
      return res.status(400).json({ error: 'startDate, endDate, notionalPerTrade required' });
    }
    res.json(
      await runTweetBacktest({
        startDate,
        endDate,
        notionalPerTrade: Number(notionalPerTrade),
        holdDays: holdDays ? Number(holdDays) : 1,
        holdHours: holdHours ? Number(holdHours) : null,
        confidenceThreshold: confidenceThreshold ? Number(confidenceThreshold) : undefined,
        maxPosts: maxPosts ? Number(maxPosts) : 200,
        stopLossPct: stopLossPct ? Number(stopLossPct) : null,
        takeProfitPct: takeProfitPct ? Number(takeProfitPct) : null,
      })
    );
  } catch (err) {
    log.error('server', `Tweet backtest failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ---------- static frontend (production build) ----------
const clientDist = path.join(config.projectRoot, 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

// ---------- startup ----------
app.listen(config.port, '127.0.0.1', () => {
  log.info('server', `================================================================`);
  log.info('server', `TRADING MODE: ${config.tradingMode.toUpperCase()}${config.isLive ? ' — REAL ORDERS WILL BE PLACED' : ' (no live orders)'}`);
  for (const fund of enabledFunds) {
    log.info('server', `Fund "${fund.name}": ${fund.paper ? 'PAPER' : 'LIVE'} account, sources [${fund.sources.join(', ')}]${fund.autoExit ? ', auto-exit on' : ''}`);
  }
  log.info('server', `Dashboard: http://localhost:${config.port}`);
  log.info('server', `================================================================`);

  for (const client of fundClients.values()) {
    client.startFillStream();
  }
  startCongressPoller();
  startTruthSocialPoller();
  startPositionManager();

  // SEC ticker universe (name/CIK/sector lookups) — background, best-effort
  ensureTickerUniverse();

  // Refresh every fund's P&L / circuit breaker every minute
  setInterval(() => {
    refreshAllFundsPnl().catch((err) => log.error('server', `P&L refresh failed: ${err.message}`));
  }, 60_000);
});
