import Alpaca from '@alpacahq/alpaca-trade-api';
import { enabledFunds } from './config.js';
import { insertFill, updateOrderStatus } from './db.js';
import { log } from './logger.js';

// One Alpaca connection per fund (fund = one account/key pair), plus a shared
// client for account-independent market data (clock, assets, quotes, bars).

function makeSdk(fund) {
  return new Alpaca({ keyId: fund.keyId, secretKey: fund.secretKey, paper: fund.paper });
}

export function createFundClient(fund) {
  const sdk = makeSdk(fund);
  return {
    fund,
    getAccount: () => sdk.getAccount(),
    getPositions: () => sdk.getPositions(),
    cancelAllOrders: () => sdk.cancelAllOrders(),

    /** Submit a notional market order. Caller is responsible for risk checks. */
    submitNotionalOrder: ({ ticker, side, notionalUsd }) =>
      sdk.createOrder({
        symbol: ticker,
        notional: Number(notionalUsd.toFixed(2)),
        side, // 'buy' | 'sell'
        type: 'market',
        time_in_force: 'day',
      }),

    /** Connect this fund's trade-updates websocket and persist fill events. */
    startFillStream() {
      const ws = sdk.trade_ws;
      ws.onConnect(() => {
        log.info('alpaca', `[${fund.name}] trade-updates websocket connected`);
        ws.subscribe(['trade_updates']);
      });
      ws.onOrderUpdate((update) => {
        const { event, order } = update;
        log.info('alpaca', `[${fund.name}] order update: ${event} ${order?.symbol} (${order?.id})`);
        if (!order?.id) return;
        if (event === 'fill' || event === 'partial_fill') {
          insertFill({
            alpacaOrderId: order.id,
            filledQty: Number(order.filled_qty),
            filledAvgPrice: Number(order.filled_avg_price),
          });
          updateOrderStatus(order.id, event === 'fill' ? 'filled' : 'partially_filled');
        } else if (['canceled', 'rejected', 'expired'].includes(event)) {
          updateOrderStatus(order.id, event);
        }
      });
      ws.onError((err) => log.error('alpaca', `[${fund.name}] websocket error: ${err?.message || err}`));
      ws.onDisconnect(() => log.warn('alpaca', `[${fund.name}] trade-updates websocket disconnected`));
      ws.connect();
      return ws;
    },
  };
}

export const fundClients = new Map(enabledFunds.map((f) => [f.name, createFundClient(f)]));

export function getFundClient(fundName) {
  const client = fundClients.get(fundName);
  if (!client) throw new Error(`Unknown fund "${fundName}"`);
  return client;
}

// ---------------------------------------------------------------------------
// Shared market data (account-independent) — uses the first fund's keys.
// ---------------------------------------------------------------------------

const marketSdk = makeSdk(enabledFunds[0]);

export async function getClock() {
  return marketSdk.getClock();
}

export async function isMarketOpen() {
  const clock = await getClock();
  return clock.is_open;
}

/** Is this symbol tradable on Alpaca? Returns the asset or null. */
export async function getTradableAsset(ticker) {
  try {
    const asset = await marketSdk.getAsset(ticker);
    return asset.tradable ? asset : null;
  } catch {
    return null;
  }
}

export async function getLatestQuote(ticker) {
  return marketSdk.getLatestQuote(ticker);
}

async function collectBars(resp, dateSlice) {
  const bars = [];
  for await (const bar of resp) {
    bars.push({
      date: String(bar.Timestamp).slice(0, dateSlice),
      timestamp: bar.Timestamp,
      open: bar.OpenPrice,
      high: bar.HighPrice,
      low: bar.LowPrice,
      close: bar.ClosePrice,
      volume: bar.Volume ?? null,
    });
  }
  return bars;
}

/**
 * Historical daily bars between two dates (inclusive).
 * Returns [{ date: 'YYYY-MM-DD', open, high, low, close }] ascending.
 */
export async function getDailyBars(ticker, startDate, endDate) {
  const resp = marketSdk.getBarsV2(ticker, {
    start: startDate,
    end: endDate,
    timeframe: '1Day',
    // IEX feed is available on the free data tier; SIP requires a paid plan.
    feed: 'iex',
  });
  return collectBars(resp, 10);
}

/**
 * Historical minute bars between two ISO timestamps.
 * Returns [{ timestamp, open, high, low, close }] ascending.
 */
export async function getMinuteBars(ticker, startIso, endIso) {
  const resp = marketSdk.getBarsV2(ticker, {
    start: startIso,
    end: endIso,
    timeframe: '1Min',
    feed: 'iex',
    limit: 10000,
  });
  return collectBars(resp, 16);
}
