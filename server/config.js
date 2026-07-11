import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

dotenv.config({ path: path.join(projectRoot, '.env') });

function required(name) {
  const v = process.env[name];
  if (v === undefined || v === '') {
    throw new Error(`Missing required env var ${name} — copy .env.example to .env and fill it in`);
  }
  return v;
}

function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (Number.isNaN(n)) throw new Error(`Env var ${name} must be a number, got "${raw}"`);
  return n;
}

function checkPositive(label, v, { integer = false, max = Infinity } = {}) {
  if (v == null) return; // unset limits stay disabled
  if (!Number.isFinite(v) || v <= 0 || v > max || (integer && !Number.isInteger(v))) {
    const kind = integer ? 'positive integer' : 'positive number';
    throw new Error(`${label} must be a ${kind}${max < Infinity ? ` ≤ ${max}` : ''}, got ${v}`);
  }
}

function checkUnitInterval(label, v) {
  if (v == null) return;
  if (!Number.isFinite(v) || v < 0 || v > 1) {
    throw new Error(`${label} must be between 0 and 1, got ${v}`);
  }
}

/** Fail fast on nonsense risk limits (negative caps, fractional position counts). */
export function validateRiskLimits(risk, label) {
  checkPositive(`${label}.maxTradeNotionalUsd`, risk.maxTradeNotionalUsd);
  checkPositive(`${label}.maxTradePctEquity`, risk.maxTradePctEquity, { max: 100 });
  checkPositive(`${label}.maxOpenPositions`, risk.maxOpenPositions, { integer: true });
  checkPositive(`${label}.maxTotalExposureUsd`, risk.maxTotalExposureUsd);
  checkPositive(`${label}.maxDailyLossUsd`, risk.maxDailyLossUsd);
  checkPositive(`${label}.maxDailyLossPct`, risk.maxDailyLossPct, { max: 100 });
}

export function validateAutoExit(autoExit, label) {
  if (!autoExit) return;
  checkPositive(`${label}.stopLossPct`, autoExit.stopLossPct, { max: 100 });
  checkPositive(`${label}.takeProfitPct`, autoExit.takeProfitPct);
  checkPositive(`${label}.maxHoldDays`, autoExit.maxHoldDays);
}

const TRADING_MODE = process.env.TRADING_MODE || 'dry_run';
if (!['dry_run', 'live'].includes(TRADING_MODE)) {
  throw new Error(`TRADING_MODE must be "dry_run" or "live", got "${TRADING_MODE}"`);
}
const SIGNAL_ROUTING = process.env.SIGNAL_ROUTING || 'legacy';
if (!['legacy', 'strategies'].includes(SIGNAL_ROUTING)) {
  throw new Error(`SIGNAL_ROUTING must be "legacy" or "strategies", got "${SIGNAL_ROUTING}"`);
}

export const config = {
  tradingMode: TRADING_MODE,
  isLive: TRADING_MODE === 'live',

  projectRoot,
  dbPath: path.join(projectRoot, 'trading.db'),
  haltFilePath: path.join(projectRoot, 'HALT'),

  quiverApiKey: process.env.QUIVER_API_KEY || '',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  youtubeApiKey: process.env.YOUTUBE_API_KEY || '',
  congressGovApiKey: process.env.CONGRESS_GOV_API_KEY || '',

  // SEC asks for a contact in the User-Agent of api requests (sec.gov/os/accessing-edgar-data)
  secContactEmail: process.env.SEC_CONTACT_EMAIL || '',
  dataCacheDir: path.join(projectRoot, 'data-cache'),

  notify: {
    macos: process.env.NOTIFY_MACOS !== 'false',
    discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
  },

  risk: {
    maxTradeNotionalUsd: num('MAX_TRADE_NOTIONAL_USD', 100),
    maxTradePctEquity: num('MAX_TRADE_PCT_EQUITY', 2),
    maxOpenPositions: num('MAX_OPEN_POSITIONS', 10),
    maxTotalExposureUsd: num('MAX_TOTAL_EXPOSURE_USD', 1000),
    maxDailyLossUsd: num('MAX_DAILY_LOSS_USD', 50),
    maxDailyLossPct: num('MAX_DAILY_LOSS_PCT', 2),
  },

  signals: {
    sentimentConfidenceThreshold: num('SENTIMENT_CONFIDENCE_THRESHOLD', 0.8),
    sentimentMinRelevance: num('SENTIMENT_MIN_RELEVANCE', 0.5),
    congressMaxDisclosureAgeDays: num('CONGRESS_MAX_DISCLOSURE_AGE_DAYS', 3),
    congressMinCopyScore: num('CONGRESS_MIN_COPY_SCORE', null),
    sentimentMaxPostAgeMinutes: num('SENTIMENT_MAX_POST_AGE_MINUTES', 15),
    routing: SIGNAL_ROUTING,
    approvalTtlHours: num('APPROVAL_TTL_HOURS', 24),
  },

  influence: {
    enabled: process.env.INFLUENCE_ENABLED !== 'false',
    youtubeEnabled: process.env.YOUTUBE_ENABLED !== 'false',
    manualTranscriptsEnabled: process.env.YOUTUBE_MANUAL_TRANSCRIPTS_ENABLED !== 'false',
    creatorAuthorizedCaptionsEnabled: process.env.YOUTUBE_CREATOR_AUTHORIZED_CAPTIONS_ENABLED === 'true',
    llmClassificationEnabled: process.env.YOUTUBE_LLM_CLASSIFICATION_ENABLED !== 'false',
    backtestingEnabled: process.env.YOUTUBE_BACKTESTING_ENABLED !== 'false',
    liveSignalsEnabled: process.env.YOUTUBE_LIVE_SIGNALS_ENABLED === 'true',
    syncMaxResults: num('YOUTUBE_SYNC_MAX_RESULTS', 10),
    pollSeconds: num('YOUTUBE_POLL_SECONDS', 1800),
    signalQualityThreshold: num('YOUTUBE_SIGNAL_QUALITY_THRESHOLD', 70),
    // Automated caption fetching is a YouTube ToS gray area — explicit opt-in.
    autoTranscriptsEnabled: process.env.YOUTUBE_AUTO_TRANSCRIPTS_ENABLED === 'true',
    ytDlpPath: process.env.YT_DLP_PATH || 'yt-dlp',
    transcriptMaxAttempts: num('YOUTUBE_TRANSCRIPT_MAX_ATTEMPTS', 3),
    transcriptFetchDelayMs: num('YOUTUBE_TRANSCRIPT_FETCH_DELAY_MS', 5000),
    pollMaxVideosPerRun: num('YOUTUBE_POLL_MAX_VIDEOS_PER_RUN', 10),
    backfillMaxPerRun: num('YOUTUBE_BACKFILL_MAX_PER_RUN', 5),
    rosterSeedEnabled: process.env.YOUTUBE_ROSTER_SEED_ENABLED !== 'false',
  },

  polling: {
    congressCron: process.env.CONGRESS_POLL_CRON || '*/20 * * * *',
    youtubeCron: process.env.YOUTUBE_POLL_CRON || '*/30 * * * *',
    truthSocialSeconds: num('TRUTH_SOCIAL_POLL_SECONDS', 30),
    truthSocialUsername: process.env.TRUTH_SOCIAL_USERNAME || 'realDonaldTrump',
  },

  sentimentModel: process.env.SENTIMENT_MODEL || 'claude-haiku-4-5-20251001',

  // Thesis cards are deterministic by default; THESIS_LLM=true adds an optional,
  // fault-tolerant Claude rewrite of the card into an analyst note.
  thesis: {
    llmEnabled: process.env.THESIS_LLM === 'true',
    model: process.env.THESIS_MODEL || process.env.SENTIMENT_MODEL || 'claude-haiku-4-5-20251001',
  },

  port: num('PORT', 3000),
};

validateRiskLimits(config.risk, 'risk');
checkUnitInterval('SENTIMENT_CONFIDENCE_THRESHOLD', config.signals.sentimentConfidenceThreshold);
checkUnitInterval('SENTIMENT_MIN_RELEVANCE', config.signals.sentimentMinRelevance);

// ---------------------------------------------------------------------------
// Funds — each is one Alpaca account (key pair) with its own limits, signal
// routing, and kill switch. Defined in funds.json (secrets stay in .env; the
// file references env-var NAMES). Without funds.json, a single "default" fund
// is synthesized from the legacy ALPACA_* vars so v1 setups keep working.
// ---------------------------------------------------------------------------

const VALID_SOURCES = ['congress', 'sentiment'];

function riskFromEnv() {
  return {
    maxTradeNotionalUsd: num('MAX_TRADE_NOTIONAL_USD', 100),
    maxTradePctEquity: num('MAX_TRADE_PCT_EQUITY', 2),
    maxOpenPositions: num('MAX_OPEN_POSITIONS', 10),
    maxTotalExposureUsd: num('MAX_TOTAL_EXPOSURE_USD', 1000),
    maxDailyLossUsd: num('MAX_DAILY_LOSS_USD', 50),
    maxDailyLossPct: num('MAX_DAILY_LOSS_PCT', 2),
  };
}

function loadFunds() {
  const fundsPath = path.resolve(config.projectRoot, 'funds.json');
  if (!fs.existsSync(fundsPath)) {
    return [
      {
        name: 'default',
        keyId: required('ALPACA_API_KEY'),
        secretKey: required('ALPACA_SECRET_KEY'),
        paper: process.env.ALPACA_PAPER !== 'false',
        enabled: true,
        sources: [...VALID_SOURCES],
        risk: riskFromEnv(),
        sentimentConfidenceThreshold: config.signals.sentimentConfidenceThreshold,
        autoExit: null,
        allowAutoStrategies: false,
      },
    ];
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(fundsPath, 'utf8'));
  } catch (err) {
    throw new Error(`funds.json is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('funds.json must be a non-empty array of fund definitions');
  }

  const names = new Set();
  const keyPairs = new Set();
  const envRisk = riskFromEnv();

  return raw.map((f, i) => {
    if (!f.name || !/^[a-zA-Z0-9_-]+$/.test(f.name)) {
      throw new Error(`funds.json[${i}]: name is required (letters/digits/dash/underscore only)`);
    }
    if (names.has(f.name)) throw new Error(`funds.json: duplicate fund name "${f.name}"`);
    names.add(f.name);

    if (!f.keyEnv || !f.secretEnv) {
      throw new Error(`funds.json: fund "${f.name}" needs keyEnv and secretEnv (env-var names holding its Alpaca keys)`);
    }
    const keyId = required(f.keyEnv);
    const secretKey = required(f.secretEnv);
    const pair = `${keyId}:${secretKey}`;
    if (keyPairs.has(pair)) {
      throw new Error(
        `funds.json: funds must not share an Alpaca key pair ("${f.name}") — ` +
          'the circuit breaker measures whole-account equity, so one account = one fund'
      );
    }
    keyPairs.add(pair);

    const sources = Array.isArray(f.sources) ? f.sources : [...VALID_SOURCES];
    for (const s of sources) {
      if (!VALID_SOURCES.includes(s)) {
        throw new Error(`funds.json: fund "${f.name}" has unknown source "${s}"`);
      }
    }

    const risk = { ...envRisk, ...(f.risk || {}) };
    const sentimentConfidenceThreshold =
      f.sentimentConfidenceThreshold ?? config.signals.sentimentConfidenceThreshold;
    validateRiskLimits(risk, `funds.json "${f.name}" risk`);
    validateAutoExit(f.autoExit, `funds.json "${f.name}" autoExit`);
    checkUnitInterval(`funds.json "${f.name}" sentimentConfidenceThreshold`, sentimentConfidenceThreshold);

    return {
      name: f.name,
      keyId,
      secretKey,
      paper: f.paper !== false,
      enabled: f.enabled !== false,
      sources,
      risk,
      sentimentConfidenceThreshold,
      autoExit: f.autoExit || null,
      allowAutoStrategies: f.allowAutoStrategies === true,
    };
  });
}

export const funds = loadFunds();
export const enabledFunds = funds.filter((f) => f.enabled);

if (enabledFunds.length === 0) {
  throw new Error('No enabled funds — enable at least one fund in funds.json');
}

for (const f of enabledFunds) {
  if (config.isLive && !f.paper) {
    console.warn(
      `[config] Fund "${f.name}" targets the LIVE Alpaca account and TRADING_MODE=live — real money will move.`
    );
  }
}

// ---------------------------------------------------------------------------
// Mode ladder (Phase 12.1): research → paper → manual → semi-auto. Fully
// automatic strategy execution is the top rung and is gated twice: the target
// fund must opt in (funds.json "allowAutoStrategies": true) AND the process must
// run live (TRADING_MODE=live). Anything short of both is refused at save time.
// ---------------------------------------------------------------------------

export function getFund(name) {
  return funds.find((f) => f.name === name) || null;
}

/** Throw if a strategy's action.mode is not permitted for its target fund. */
export function assertStrategyModeAllowed(action) {
  if (!action || action.mode !== 'auto') return;
  const fund = getFund(action.fund);
  if (!fund) throw new Error(`auto-mode strategy targets unknown fund "${action.fund}"`);
  if (!fund.allowAutoStrategies) {
    throw new Error(
      `fund "${fund.name}" does not permit auto-mode strategies — set "allowAutoStrategies": true in funds.json ` +
        'or use a lower mode (watch, paper, manual)'
    );
  }
  if (!config.isLive) {
    throw new Error('auto-mode strategies require TRADING_MODE=live (currently dry_run)');
  }
}

/** Per-fund compliance posture for the startup log and GET /api/posture. */
export function fundPosture(fund) {
  return {
    name: fund.name,
    account: fund.paper ? 'paper' : 'live',
    tradingMode: config.tradingMode,
    sources: fund.sources,
    allowAutoStrategies: !!fund.allowAutoStrategies,
    // Auto strategies only actually execute when the fund opts in AND we're live.
    autoStrategiesEffective: !!fund.allowAutoStrategies && config.isLive,
  };
}
