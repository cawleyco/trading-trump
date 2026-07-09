import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import cron from 'node-cron';
import { config, enabledFunds } from './config.js';
import {
  listSignalsWithDecisions,
  getSeenPost,
  getDailyPnl,
  getActiveKillSwitchEvent,
  recordKillSwitchTrip,
  resetKillSwitch,
  listBacktests,
  getBacktest,
  listReviewQueue,
  resolveReviewItem,
  getCongressTradeByKey,
  getTradeGraphContext,
  getPoliticianGraphContext,
  listTradesWithScores,
  listEvents,
  listRecentTradesForTickers,
  createYoutubeChannel,
  upsertYoutubeChannel,
  listYoutubeChannels,
  getYoutubeChannel,
  updateYoutubeChannel,
  insertYoutubeChannelSnapshot,
  markYoutubeChannelSynced,
  upsertYoutubeVideo,
  listYoutubeVideos,
  getYoutubeVideo,
  insertYoutubeVideoSnapshot,
  updateYoutubeVideoStatuses,
  createContentDocument,
  insertContentSegments,
  listContentDocumentsForVideo,
  listContentSegmentsForVideo,
  listAssetMentions,
  getAssetMention,
  createMentionClassification,
  listMentionClassifications,
  listYoutubeBacktestRuns,
  getYoutubeBacktestRun,
  listInfluenceSignals,
  getInfluenceSignal,
  updateInfluenceSignal,
  getYoutubeDashboardStats,
  getCreatorAlpha,
} from './db.js';
import { filingSpeedLeaderboard } from './intel/freshnessReports.js';
import { getStatsProfile, listStats, refreshAllPoliticianStats } from './intel/politicianStats.js';
import { rescoreRecentTrades, scoreTrade } from './intel/scoreRunner.js';
import { getOrBuildThesisCard } from './intel/cardRunner.js';
import { buildCrossSignalContext } from './intel/crossSignal.js';
import { driftSincePct } from './marketData.js';
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
import { ensureLegislatorsAndCommittees, refreshLegislatorsAndCommittees } from './sources/legislators.js';
import { refreshRecentBills } from './sources/congressGov.js';
import { refreshLobbyingFilings } from './sources/lobbying.js';
import { refreshGovContracts } from './sources/contracts.js';
import { refreshPoliticalEvents } from './sources/eventsCollector.js';
import { startPositionManager } from './positionManager.js';
import { runCongressBacktest, runCongressLeaderboard, runEntryBasisComparison, listPoliticians, ENTRY_BASES } from './backtest/congressBacktest.js';
import { runWalkForward } from './backtest/walkForward.js';
import { runTweetBacktest } from './backtest/tweetBacktest.js';
import { runYoutubeBacktest, recalculateCreatorAlpha } from './backtest/youtubeBacktest.js';
import { getAttribution } from './attribution.js';
import { log } from './logger.js';
import {
  resolveChannelId,
  getChannelMetadata,
  listLatestVideosFromUploadsPlaylist,
  getVideoMetadata,
} from './sources/youtubeApiClient.js';
import { ManualTranscriptProvider } from './influence/transcripts.js';
import { detectAndStoreYoutubeMentions } from './influence/youtubeMentionDetection.js';
import { classifyAndStoreYoutubeMention, normalizeClassification } from './influence/youtubeMentionClassifier.js';
import { generateYoutubeSignals } from './influence/youtubeSignals.js';

const app = express();
app.use(express.json({ limit: '5mb' }));

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

// ---------- intelligence: freshness reports ----------
app.get('/api/intel/filing-speed', (req, res) => {
  const minTrades = Number(req.query.minTrades) || 3;
  res.json(filingSpeedLeaderboard({ minTrades }));
});

app.get('/api/intel/politicians', (req, res) => {
  res.json(listStats(Number(req.query.limit) || 500));
});

app.get('/api/intel/politicians/:name', (req, res) => {
  const profile = getStatsProfile(req.params.name);
  if (!profile) return res.status(404).json({ error: 'unknown politician stats; run refresh first' });
  res.json(profile);
});

app.post('/api/intel/refresh-stats', async (req, res) => {
  try {
    res.json(await refreshAllPoliticianStats());
  } catch (err) {
    log.error('server', `Politician stats refresh failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/intel/refresh-graph', async (req, res) => {
  try {
    const [legislators, bills, lobbying, contracts] = await Promise.all([
      refreshLegislatorsAndCommittees(),
      refreshRecentBills(),
      refreshLobbyingFilings(),
      refreshGovContracts(),
    ]);
    res.json({ legislators, bills, lobbying, contracts });
  } catch (err) {
    log.error('server', `Knowledge graph refresh failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/intel/graph/:tradeKey', (req, res) => {
  const context = getTradeGraphContext(req.params.tradeKey);
  if (!context) return res.status(404).json({ error: 'unknown trade key' });
  res.json(context);
});

app.get('/api/intel/cross-signal/:postId', (req, res) => {
  const post = getSeenPost(req.params.postId);
  if (!post) return res.status(404).json({ error: 'unknown post id' });
  res.json(buildCrossSignalContext(req.params.postId, { post }));
});

app.get('/api/intel/politicians/:name/graph', (req, res) => {
  const context = getPoliticianGraphContext(req.params.name);
  if (!context) return res.status(404).json({ error: 'unknown politician graph context; run graph refresh first' });
  res.json(context);
});

// tradeKey contains "|" and spaces — clients must URL-encode it.
app.get('/api/intel/drift/:tradeKey', async (req, res) => {
  const trade = getCongressTradeByKey(req.params.tradeKey);
  if (!trade) return res.status(404).json({ error: 'unknown trade key' });
  try {
    const [sinceTransactionPct, sinceDisclosurePct] = await Promise.all([
      driftSincePct(trade.ticker, trade.transaction_date),
      driftSincePct(trade.ticker, trade.disclosure_date),
    ]);
    res.json({ ticker: trade.ticker, sinceTransactionPct, sinceDisclosurePct });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/intel/score/:tradeKey', async (req, res) => {
  try {
    res.json(await scoreTrade(req.params.tradeKey, { force: req.body?.force === true }));
  } catch (err) {
    const status = err.message.startsWith('unknown trade key') ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

// Deterministic thesis card for one trade (scores + caches on demand).
// tradeKey contains "|" and spaces — clients must URL-encode it.
app.get('/api/intel/card/:tradeKey', async (req, res) => {
  try {
    res.json(await getOrBuildThesisCard(req.params.tradeKey, { force: req.query.force === 'true' }));
  } catch (err) {
    const status = err.message.startsWith('unknown trade key') ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

app.get('/api/intel/trades', (req, res) => {
  const minScore = req.query.minScore == null || req.query.minScore === ''
    ? null
    : Number(req.query.minScore);
  if (minScore != null && !Number.isFinite(minScore)) {
    return res.status(400).json({ error: 'minScore must be a number' });
  }
  res.json(listTradesWithScores({
    since: req.query.since || undefined,
    minScore,
    recommendation: req.query.recommendation || undefined,
    politician: req.query.politician || undefined,
    ticker: req.query.ticker || undefined,
    limit: Number(req.query.limit) || 200,
  }));
});

app.get('/api/intel/events', (req, res) => {
  const events = listEvents({
    from: req.query.from || undefined,
    to: req.query.to || undefined,
    sector: req.query.sector || undefined,
    limit: Number(req.query.limit) || 300,
  }).map((event) => ({
    ...event,
    recentTrades: listRecentTradesForTickers(event.related_tickers || [], {
      since: event.event_date,
      limit: 12,
    }),
  }));
  res.json(events);
});

app.post('/api/intel/events/refresh', async (req, res) => {
  try {
    res.json(await refreshPoliticalEvents({
      from: req.body?.from || undefined,
      to: req.body?.to || undefined,
    }));
  } catch (err) {
    log.error('server', `Political events refresh failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
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

function validEntryBasis(v) {
  if (v == null) return 'disclosure';
  if (!ENTRY_BASES.includes(v)) throw new Error(`entryBasis must be one of ${ENTRY_BASES.join(', ')}`);
  return v;
}

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
        entryBasis: validEntryBasis(req.body.entryBasis),
      })
    );
  } catch (err) {
    log.error('server', `Congress backtest failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/backtests/congress/compare', async (req, res) => {
  try {
    const { politician, startDate, endDate, notionalPerTrade, exitRule, stopLossPct, takeProfitPct } = req.body;
    if (!politician || !startDate || !endDate || !notionalPerTrade) {
      return res.status(400).json({ error: 'politician, startDate, endDate, notionalPerTrade required' });
    }
    res.json(
      await runEntryBasisComparison({
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
    log.error('server', `Compare-modes backtest failed: ${err.message}`);
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
        entryBasis: validEntryBasis(req.body.entryBasis),
      })
    );
  } catch (err) {
    log.error('server', `Leaderboard backtest failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/backtests/walk-forward', async (req, res) => {
  try {
    const { startDate, endDate, notionalPerTrade, folds, topN, exitRule, minTrades } = req.body;
    if (!startDate || !endDate || !notionalPerTrade) {
      return res.status(400).json({ error: 'startDate, endDate, notionalPerTrade required' });
    }
    const foldCount = folds == null ? 4 : Number(folds);
    const topCount = topN == null ? 5 : Number(topN);
    const minTradeCount = minTrades == null ? 3 : Number(minTrades);
    if (!Number.isFinite(foldCount) || foldCount < 2) {
      return res.status(400).json({ error: 'folds must be at least 2' });
    }
    if (!Number.isFinite(topCount) || topCount < 1) {
      return res.status(400).json({ error: 'topN must be at least 1' });
    }
    if (!Number.isFinite(minTradeCount) || minTradeCount < 1) {
      return res.status(400).json({ error: 'minTrades must be at least 1' });
    }
    res.json(
      await runWalkForward({
        startDate,
        endDate,
        notionalPerTrade: Number(notionalPerTrade),
        folds: foldCount,
        topN: topCount,
        exitRule,
        minTrades: minTradeCount,
        entryBasis: validEntryBasis(req.body.entryBasis),
      })
    );
  } catch (err) {
    log.error('server', `Walk-forward backtest failed: ${err.message}`);
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

// ---------- Influence Signals / YouTube ----------
function numericIdParam(req, res) {
  if (!/^\d+$/.test(req.params.id)) {
    res.status(400).json({ error: 'numeric id required' });
    return null;
  }
  return Number(req.params.id);
}

function requireInfluence(req, res) {
  if (!config.influence.enabled || !config.influence.youtubeEnabled) {
    res.status(404).json({ error: 'Influence Signals YouTube module is disabled' });
    return false;
  }
  return true;
}

app.get('/api/influence/youtube/dashboard', (req, res) => {
  if (!requireInfluence(req, res)) return;
  res.json(getYoutubeDashboardStats());
});

app.get('/api/influence/youtube/channels', (req, res) => {
  if (!requireInfluence(req, res)) return;
  res.json(listYoutubeChannels({ limit: Number(req.query.limit) || 500 }));
});

app.post('/api/influence/youtube/channels', async (req, res) => {
  if (!requireInfluence(req, res)) return;
  try {
    if (req.body.resolveWithApi) {
      const channelId = await resolveChannelId(req.body.input || req.body.youtube_channel_id || req.body.handle);
      const metadata = await getChannelMetadata(channelId);
      const channel = upsertYoutubeChannel({
        ...metadata,
        category: req.body.category,
        influence_tier: req.body.influence_tier,
        risk_notes: req.body.risk_notes,
        tracking_enabled: req.body.tracking_enabled !== false,
      });
      insertYoutubeChannelSnapshot(channel.id, channel);
      return res.json(channel);
    }
    if (!req.body.youtube_channel_id || !req.body.title) {
      return res.status(400).json({ error: 'youtube_channel_id and title are required' });
    }
    res.json(createYoutubeChannel(req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/influence/youtube/channels/:id', (req, res) => {
  if (!requireInfluence(req, res)) return;
  const id = numericIdParam(req, res);
  if (id == null) return;
  const channel = getYoutubeChannel(id);
  if (!channel) return res.status(404).json({ error: 'channel not found' });
  res.json({ ...channel, alpha: getCreatorAlpha(id) });
});

app.patch('/api/influence/youtube/channels/:id', (req, res) => {
  if (!requireInfluence(req, res)) return;
  const id = numericIdParam(req, res);
  if (id == null) return;
  const channel = updateYoutubeChannel(id, req.body || {});
  if (!channel) return res.status(404).json({ error: 'channel not found' });
  res.json(channel);
});

app.get('/api/influence/youtube/channels/:id/videos', (req, res) => {
  if (!requireInfluence(req, res)) return;
  const id = numericIdParam(req, res);
  if (id == null) return;
  res.json(listYoutubeVideos({ channelId: id, limit: Number(req.query.limit) || 200 }));
});

app.get('/api/influence/youtube/channels/:id/mentions', (req, res) => {
  if (!requireInfluence(req, res)) return;
  const id = numericIdParam(req, res);
  if (id == null) return;
  res.json(listAssetMentions({ channelId: id, limit: Number(req.query.limit) || 500 }));
});

app.get('/api/influence/youtube/channels/:id/alpha', (req, res) => {
  if (!requireInfluence(req, res)) return;
  const id = numericIdParam(req, res);
  if (id == null) return;
  res.json(getCreatorAlpha(id));
});

app.post('/api/influence/youtube/channels/:id/sync', async (req, res) => {
  if (!requireInfluence(req, res)) return;
  const id = numericIdParam(req, res);
  if (id == null) return;
  const channel = getYoutubeChannel(id);
  if (!channel) return res.status(404).json({ error: 'channel not found' });
  try {
    let current = channel;
    if (!channel.uploads_playlist_id || req.body.refreshChannelMetadata) {
      const metadata = await getChannelMetadata(channel.youtube_channel_id);
      current = updateYoutubeChannel(id, metadata);
      insertYoutubeChannelSnapshot(id, current);
    }
    if (!current.uploads_playlist_id) {
      return res.status(400).json({ error: 'channel has no uploads playlist id' });
    }
    const latest = await listLatestVideosFromUploadsPlaylist(
      current.uploads_playlist_id,
      Number(req.body.maxResults) || config.influence.syncMaxResults
    );
    const videos = [];
    for (const item of latest) {
      let full = item;
      try {
        full = { ...item, ...(await getVideoMetadata(item.youtube_video_id)) };
      } catch (err) {
        log.warn('youtube', `Video metadata failed for ${item.youtube_video_id}: ${err.message}`);
      }
      const video = upsertYoutubeVideo({ ...full, channel_id: id, ingestion_status: 'metadata_fetched' });
      if (full.stats) insertYoutubeVideoSnapshot(video.id, full.stats);
      videos.push(video);
    }
    markYoutubeChannelSynced(id);
    res.json({ channel: getYoutubeChannel(id), videos });
  } catch (err) {
    log.error('youtube', `Channel sync failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/influence/youtube/videos', (req, res) => {
  if (!requireInfluence(req, res)) return;
  res.json(listYoutubeVideos({ channelId: req.query.channelId ? Number(req.query.channelId) : null, limit: Number(req.query.limit) || 200 }));
});

app.post('/api/influence/youtube/videos', (req, res) => {
  if (!requireInfluence(req, res)) return;
  if (!req.body.youtube_video_id || !req.body.channel_id || !req.body.title || !req.body.published_at) {
    return res.status(400).json({ error: 'youtube_video_id, channel_id, title, and published_at are required' });
  }
  res.json(upsertYoutubeVideo({ ...req.body, ingestion_status: 'metadata_fetched' }));
});

app.get('/api/influence/youtube/videos/:id', (req, res) => {
  if (!requireInfluence(req, res)) return;
  const id = numericIdParam(req, res);
  if (id == null) return;
  const video = getYoutubeVideo(id);
  if (!video) return res.status(404).json({ error: 'video not found' });
  res.json({
    ...video,
    documents: listContentDocumentsForVideo(id),
    segments: listContentSegmentsForVideo(id),
    mentions: listAssetMentions({ videoId: id, limit: 500 }),
  });
});

app.post('/api/influence/youtube/videos/:id/sync', async (req, res) => {
  if (!requireInfluence(req, res)) return;
  const id = numericIdParam(req, res);
  if (id == null) return;
  const video = getYoutubeVideo(id);
  if (!video) return res.status(404).json({ error: 'video not found' });
  try {
    const metadata = await getVideoMetadata(video.youtube_video_id);
    const updated = upsertYoutubeVideo({ ...metadata, channel_id: video.channel_id, ingestion_status: 'metadata_fetched' });
    if (metadata.stats) insertYoutubeVideoSnapshot(updated.id, metadata.stats);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/influence/youtube/videos/:id/transcript', async (req, res) => {
  if (!requireInfluence(req, res)) return;
  if (!config.influence.manualTranscriptsEnabled) return res.status(403).json({ error: 'manual transcripts disabled' });
  const id = numericIdParam(req, res);
  if (id == null) return;
  const video = getYoutubeVideo(id);
  if (!video) return res.status(404).json({ error: 'video not found' });
  const provider = new ManualTranscriptProvider({
    rawText: req.body.rawText || req.body.raw_text,
    format: req.body.format,
    language: req.body.language,
  });
  const result = await provider.fetchTranscript(video);
  if (result.status !== 'success') return res.status(400).json(result);
  const documentId = createContentDocument({
    source_type: 'youtube_video',
    source_id: id,
    provider_name: result.providerName,
    language: result.language,
    raw_text: result.rawText,
    source_format: result.format,
    authorization_status: req.body.authorizationStatus || 'manual_upload',
  });
  insertContentSegments(documentId, result.segments);
  updateYoutubeVideoStatuses(id, { transcript_status: 'available' });
  res.json({ documentId, segments: listContentSegmentsForVideo(id) });
});

app.post('/api/influence/youtube/videos/:id/analyze', async (req, res) => {
  if (!requireInfluence(req, res)) return;
  const id = numericIdParam(req, res);
  if (id == null) return;
  const video = getYoutubeVideo(id);
  if (!video) return res.status(404).json({ error: 'video not found' });
  const detection = detectAndStoreYoutubeMentions(video);
  updateYoutubeVideoStatuses(id, { analysis_status: 'complete' });
  res.json({ detection, mentions: listAssetMentions({ videoId: id, limit: 500 }) });
});

app.get('/api/influence/youtube/videos/:id/mentions', (req, res) => {
  if (!requireInfluence(req, res)) return;
  const id = numericIdParam(req, res);
  if (id == null) return;
  res.json(listAssetMentions({ videoId: id, limit: Number(req.query.limit) || 500 }));
});

app.get('/api/influence/youtube/videos/:id/backtest-results', (req, res) => {
  if (!requireInfluence(req, res)) return;
  const id = numericIdParam(req, res);
  if (id == null) return;
  res.json(runYoutubeBacktest({ name: `Video ${id} mention backtest`, videoId: id, limit: 500 }));
});

app.get('/api/influence/youtube/mentions', (req, res) => {
  if (!requireInfluence(req, res)) return;
  res.json(listAssetMentions({
    videoId: req.query.videoId ? Number(req.query.videoId) : null,
    channelId: req.query.channelId ? Number(req.query.channelId) : null,
    assetId: req.query.assetId ? Number(req.query.assetId) : null,
    limit: Number(req.query.limit) || 500,
  }));
});

app.get('/api/influence/youtube/mentions/:id', (req, res) => {
  if (!requireInfluence(req, res)) return;
  const id = numericIdParam(req, res);
  if (id == null) return;
  const mention = getAssetMention(id);
  if (!mention) return res.status(404).json({ error: 'mention not found' });
  res.json({ ...mention, classifications: listMentionClassifications(id) });
});

app.patch('/api/influence/youtube/mentions/:id', (req, res) => {
  if (!requireInfluence(req, res)) return;
  const id = numericIdParam(req, res);
  if (id == null) return;
  const mention = getAssetMention(id);
  if (!mention) return res.status(404).json({ error: 'mention not found' });
  const normalized = normalizeClassification(req.body, mention);
  res.json(createMentionClassification({
    mention_id: id,
    ...normalized,
    model_name: 'manual',
    prompt_version: 'manual-override',
    raw_model_output: req.body,
    is_manual_override: true,
  }));
});

app.post('/api/influence/youtube/mentions/:id/reclassify', async (req, res) => {
  if (!requireInfluence(req, res)) return;
  const id = numericIdParam(req, res);
  if (id == null) return;
  const mention = getAssetMention(id);
  if (!mention) return res.status(404).json({ error: 'mention not found' });
  const video = mention.video_id ? getYoutubeVideo(mention.video_id) : null;
  const classification = await classifyAndStoreYoutubeMention(mention, {
    videoTitle: video?.title,
    videoDescription: video?.description,
    channelTitle: mention.channel_title,
    hasPaidProductPlacement: video?.has_paid_product_placement,
  });
  if (!classification) return res.status(400).json({ error: 'classification unavailable' });
  res.json(classification);
});

app.get('/api/influence/youtube/mentions/:id/backtest', (req, res) => {
  if (!requireInfluence(req, res)) return;
  const id = numericIdParam(req, res);
  if (id == null) return;
  res.json(runYoutubeBacktest({ name: `Mention ${id} backtest`, mentionId: id, limit: 500 }));
});

app.get('/api/influence/youtube/backtests', (req, res) => {
  if (!requireInfluence(req, res)) return;
  res.json(listYoutubeBacktestRuns());
});

app.post('/api/influence/youtube/backtests', (req, res) => {
  if (!requireInfluence(req, res)) return;
  try {
    res.json(runYoutubeBacktest(req.body || {}));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/influence/youtube/backtests/:id', (req, res) => {
  if (!requireInfluence(req, res)) return;
  const id = numericIdParam(req, res);
  if (id == null) return;
  const run = getYoutubeBacktestRun(id);
  if (!run) return res.status(404).json({ error: 'backtest not found' });
  res.json(run);
});

app.post('/api/influence/youtube/backtests/:id/run', (req, res) => {
  if (!requireInfluence(req, res)) return;
  const id = numericIdParam(req, res);
  if (id == null) return;
  const run = getYoutubeBacktestRun(id);
  if (!run) return res.status(404).json({ error: 'backtest not found' });
  res.json(runYoutubeBacktest({ ...run.strategy_config, name: `${run.name} rerun` }));
});

app.post('/api/influence/youtube/channels/:id/recalculate-alpha', (req, res) => {
  if (!requireInfluence(req, res)) return;
  const id = numericIdParam(req, res);
  if (id == null) return;
  res.json(recalculateCreatorAlpha(id));
});

app.post('/api/influence/youtube/videos/:id/signals', (req, res) => {
  if (!requireInfluence(req, res)) return;
  const id = numericIdParam(req, res);
  if (id == null) return;
  res.json(generateYoutubeSignals({ videoId: id }));
});

app.get('/api/influence/signals', (req, res) => {
  if (!config.influence.enabled) return res.status(404).json({ error: 'Influence Signals module is disabled' });
  res.json(listInfluenceSignals({ moduleKey: req.query.moduleKey, limit: Number(req.query.limit) || 100 }));
});

app.get('/api/influence/signals/:id', (req, res) => {
  if (!config.influence.enabled) return res.status(404).json({ error: 'Influence Signals module is disabled' });
  const id = numericIdParam(req, res);
  if (id == null) return;
  const signal = getInfluenceSignal(id);
  if (!signal) return res.status(404).json({ error: 'signal not found' });
  res.json(signal);
});

app.patch('/api/influence/signals/:id', (req, res) => {
  if (!config.influence.enabled) return res.status(404).json({ error: 'Influence Signals module is disabled' });
  const id = numericIdParam(req, res);
  if (id == null) return;
  const signal = updateInfluenceSignal(id, req.body || {});
  if (!signal) return res.status(404).json({ error: 'signal not found' });
  res.json(signal);
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
  ensureLegislatorsAndCommittees();
  refreshPoliticalEvents().catch((err) =>
    log.error('server', `Startup political events refresh failed: ${err.message}`)
  );

  cron.schedule(
    '0 6 * * *',
    () => {
      refreshAllPoliticianStats().catch((err) =>
        log.error('server', `Scheduled politician stats refresh failed: ${err.message}`)
      );
    },
    { timezone: 'America/New_York' }
  );

  cron.schedule(
    '30 6 * * *',
    () => {
      rescoreRecentTrades({ days: 60 }).catch((err) =>
        log.error('server', `Scheduled copy-score refresh failed: ${err.message}`)
      );
    },
    { timezone: 'America/New_York' }
  );

  cron.schedule(
    '0 5 * * 0',
    () => {
      refreshLegislatorsAndCommittees().catch((err) =>
        log.error('server', `Scheduled legislator/committee refresh failed: ${err.message}`)
      );
    },
    { timezone: 'America/New_York' }
  );

  cron.schedule(
    '0 5 * * *',
    () => {
      Promise.all([refreshRecentBills(), refreshLobbyingFilings(), refreshGovContracts()]).catch((err) =>
        log.error('server', `Scheduled knowledge graph activity refresh failed: ${err.message}`)
      );
    },
    { timezone: 'America/New_York' }
  );

  cron.schedule(
    '15 5 * * *',
    () => {
      refreshPoliticalEvents().catch((err) =>
        log.error('server', `Scheduled political events refresh failed: ${err.message}`)
      );
    },
    { timezone: 'America/New_York' }
  );

  // Refresh every fund's P&L / circuit breaker every minute
  setInterval(() => {
    refreshAllFundsPnl().catch((err) => log.error('server', `P&L refresh failed: ${err.message}`));
  }, 60_000);
});
