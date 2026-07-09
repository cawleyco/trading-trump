import test from 'node:test'
import assert from 'node:assert/strict'
import { processSignal } from '../server/riskManager.js'
import { db } from '../server/db.js'

// End-to-end pipeline tests against a mock broker. Real DB rows are written
// (that IS the audit trail under test) and deleted in `finally`.

const FUND = {
  name: 'ps-test-fund',
  paper: true,
  enabled: true,
  sources: ['congress'],
  risk: {
    maxTradeNotionalUsd: 100,
    maxTradePctEquity: 2,
    maxOpenPositions: 2,
    maxTotalExposureUsd: 1000,
    maxDailyLossUsd: 50,
    maxDailyLossPct: 2,
  },
  sentimentConfidenceThreshold: 0.8,
  autoExit: null,
}

function mockDeps({ isLive = false, positions = [], equity = 10_000, marketOpen = true, tradable = true } = {}) {
  const submitted = []
  return {
    submitted,
    isLive,
    isMarketOpen: async () => marketOpen,
    getTradableAsset: async (ticker) => (tradable ? { symbol: ticker } : null),
    refreshFundPnl: async () => 0,
    avgDollarVolume: async () => null,
    getFundClient: () => ({
      getAccount: async () => ({ equity: String(equity) }),
      getPositions: async () => positions,
      submitNotionalOrder: async (order) => {
        submitted.push(order)
        return { id: `mock-order-${submitted.length}` }
      },
    }),
  }
}

const buySignal = (ticker = 'AAPL') => ({
  source: 'congress',
  ticker,
  direction: 'buy',
  confidence: null,
  rationale: 'pipeline test',
  rawReference: {},
})

function auditRows(signalId) {
  const decisions = db.prepare(`SELECT * FROM decisions WHERE signal_id = ?`).all(signalId)
  const orders = decisions.length
    ? db.prepare(
        `SELECT * FROM orders WHERE decision_id IN (${decisions.map(() => '?').join(',')})`
      ).all(...decisions.map((d) => d.id))
    : []
  return { decisions, orders }
}

function cleanup(signalId) {
  if (signalId == null) return
  db.prepare(
    `DELETE FROM orders WHERE decision_id IN (SELECT id FROM decisions WHERE signal_id = ?)`
  ).run(signalId)
  db.prepare(`DELETE FROM decisions WHERE signal_id = ?`).run(signalId)
  db.prepare(`DELETE FROM signals WHERE id = ?`).run(signalId)
}

test('dry-run approves, records a simulated order, and never touches the broker', async () => {
  const deps = mockDeps({ isLive: false })
  let signalId = null
  try {
    const [outcome] = await processSignal(buySignal(), { onlyFund: FUND.name, _funds: [FUND], _deps: deps })
    signalId = outcome.signalId
    assert.equal(outcome.approved, true)
    assert.equal(outcome.simulated, true)
    assert.equal(outcome.notionalUsd, 100) // min($100 cap, 2% of $10k = $200)
    assert.equal(deps.submitted.length, 0, 'dry-run must never submit to Alpaca')

    const { decisions, orders } = auditRows(signalId)
    assert.equal(decisions.length, 1)
    assert.equal(decisions[0].approved, 1)
    assert.equal(orders.length, 1)
    assert.equal(orders[0].status, 'simulated')
  } finally {
    cleanup(signalId)
  }
})

test('live mode submits through the client and records the broker order id', async () => {
  const deps = mockDeps({ isLive: true })
  let signalId = null
  try {
    const [outcome] = await processSignal(buySignal(), { onlyFund: FUND.name, _funds: [FUND], _deps: deps })
    signalId = outcome.signalId
    assert.equal(outcome.approved, true)
    assert.equal(outcome.simulated, false)
    assert.equal(deps.submitted.length, 1)
    assert.deepEqual(deps.submitted[0], { ticker: 'AAPL', side: 'buy', notionalUsd: 100 })

    const { orders } = auditRows(signalId)
    assert.equal(orders[0].status, 'submitted')
    assert.equal(orders[0].alpaca_order_id, 'mock-order-1')
  } finally {
    cleanup(signalId)
  }
})

test('a closed market rejects the signal with the failing check on record', async () => {
  const deps = mockDeps({ marketOpen: true, isLive: true })
  deps.isMarketOpen = async () => false
  let signalId = null
  try {
    const [outcome] = await processSignal(buySignal(), { onlyFund: FUND.name, _funds: [FUND], _deps: deps })
    signalId = outcome.signalId
    assert.equal(outcome.approved, false)
    assert.match(outcome.reason, /market is closed/)
    assert.equal(deps.submitted.length, 0)

    const { decisions, orders } = auditRows(signalId)
    assert.equal(decisions[0].approved, 0)
    const checks = JSON.parse(decisions[0].checks)
    const marketCheck = checks.find((c) => c.check === 'market-open')
    assert.equal(marketCheck.pass, false)
    assert.equal(orders.length, 0, 'rejected signals must not create orders')
  } finally {
    cleanup(signalId)
  }
})

test('sell without an open position is rejected (no shorting)', async () => {
  const deps = mockDeps({ isLive: true })
  let signalId = null
  try {
    const [outcome] = await processSignal(
      { ...buySignal('TSLA'), direction: 'sell' },
      { onlyFund: FUND.name, _funds: [FUND], _deps: deps }
    )
    signalId = outcome.signalId
    assert.equal(outcome.approved, false)
    assert.match(outcome.reason, /shorting disabled/)
    assert.equal(deps.submitted.length, 0)
  } finally {
    cleanup(signalId)
  }
})

test('max open positions cap blocks new buys', async () => {
  const deps = mockDeps({
    isLive: true,
    positions: [
      { symbol: 'MSFT', market_value: '100' },
      { symbol: 'NVDA', market_value: '100' },
    ],
  })
  let signalId = null
  try {
    const [outcome] = await processSignal(buySignal(), { onlyFund: FUND.name, _funds: [FUND], _deps: deps })
    signalId = outcome.signalId
    assert.equal(outcome.approved, false)
    assert.match(outcome.reason, /max open positions/)
    assert.equal(deps.submitted.length, 0)
  } finally {
    cleanup(signalId)
  }
})

test('untradable tickers are rejected before any account access', async () => {
  const deps = mockDeps({ isLive: true, tradable: false })
  let signalId = null
  try {
    const [outcome] = await processSignal(buySignal('DELISTED'), { onlyFund: FUND.name, _funds: [FUND], _deps: deps })
    signalId = outcome.signalId
    assert.equal(outcome.approved, false)
    assert.match(outcome.reason, /not tradable/)
    assert.equal(deps.submitted.length, 0)
  } finally {
    cleanup(signalId)
  }
})

test('a broker error during submission is recorded as a rejection, not silence', async () => {
  const deps = mockDeps({ isLive: true })
  deps.getFundClient = () => ({
    getAccount: async () => ({ equity: '10000' }),
    getPositions: async () => [],
    submitNotionalOrder: async () => {
      throw new Error('alpaca 500')
    },
  })
  let signalId = null
  try {
    const [outcome] = await processSignal(buySignal(), { onlyFund: FUND.name, _funds: [FUND], _deps: deps })
    signalId = outcome.signalId
    assert.equal(outcome.approved, false)
    assert.match(outcome.reason, /alpaca 500/)
    const { decisions } = auditRows(signalId)
    // both the approval and the subsequent error rejection stay on record
    assert.equal(decisions.length, 2)
  } finally {
    cleanup(signalId)
  }
})
