import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

const TRADING_MODE = process.env.TRADING_MODE || 'dry_run';
if (!['dry_run', 'live'].includes(TRADING_MODE)) {
  throw new Error(`TRADING_MODE must be "dry_run" or "live", got "${TRADING_MODE}"`);
}

export const config = {
  tradingMode: TRADING_MODE,
  isLive: TRADING_MODE === 'live',

  projectRoot: path.resolve(__dirname, '..'),
  dbPath: path.resolve(__dirname, '..', 'trading.db'),
  haltFilePath: path.resolve(__dirname, '..', 'HALT'),

  quiverApiKey: process.env.QUIVER_API_KEY || '',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',

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
    congressMaxDisclosureAgeDays: num('CONGRESS_MAX_DISCLOSURE_AGE_DAYS', 3),
    sentimentMaxPostAgeMinutes: num('SENTIMENT_MAX_POST_AGE_MINUTES', 15),
  },

  polling: {
    congressCron: process.env.CONGRESS_POLL_CRON || '*/20 * * * *',
    truthSocialSeconds: num('TRUTH_SOCIAL_POLL_SECONDS', 30),
    truthSocialUsername: process.env.TRUTH_SOCIAL_USERNAME || 'realDonaldTrump',
  },

  sentimentModel: process.env.SENTIMENT_MODEL || 'claude-haiku-4-5-20251001',

  port: num('PORT', 3000),
};

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

    return {
      name: f.name,
      keyId,
      secretKey,
      paper: f.paper !== false,
      enabled: f.enabled !== false,
      sources,
      risk: { ...envRisk, ...(f.risk || {}) },
      sentimentConfidenceThreshold:
        f.sentimentConfidenceThreshold ?? config.signals.sentimentConfidenceThreshold,
      autoExit: f.autoExit || null,
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
