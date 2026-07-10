import test from 'node:test'
import assert from 'node:assert/strict'
import { makeTradeSignal } from '../server/signal.js'
import { previewSignal, processSignal } from '../server/riskManager.js'
import { buildManualInvestSignal, confirmInvest, previewInvest, promoteStrategyFromResearch } from '../server/invest.js'
import { createStrategy, db, deleteStrategy } from '../server/db.js'
import { config } from '../server/config.js'

const FUND = {
  name: 'invest-test-fund',
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

function mockDeps({ isLive = false, positions = [], equity = 10_000, marketOpen = true } = {}) {
  const submitted = []
  return {
    submitted,
    isLive,
    isMarketOpen: async () => marketOpen,
    getTradableAsset: async (ticker) => ({ symbol: ticker }),
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

function cleanup(signalId) {
  if (signalId == null) return
  db.prepare(
    `DELETE FROM orders WHERE decision_id IN (SELECT id FROM decisions WHERE signal_id = ?)`
  ).run(signalId)
  db.prepare(`DELETE FROM decisions WHERE signal_id = ?`).run(signalId)
  db.prepare(`DELETE FROM signals WHERE id = ?`).run(signalId)
}

test('makeTradeSignal accepts manual source', () => {
  const s = makeTradeSignal({ source: 'manual', ticker: 'AAPL', direction: 'buy', rationale: 'click' })
  assert.equal(s.source, 'manual')
})

test('buildManualInvestSignal stamps origin provenance', () => {
  const s = buildManualInvestSignal({
    ticker: 'MSFT',
    direction: 'buy',
    origin: { kind: 'backtest', backtestId: 12, label: 'Congress backtest' },
  })
  assert.equal(s.source, 'manual')
  assert.equal(s.rawReference.origin.kind, 'backtest')
  assert.equal(s.rawReference.origin.backtestId, 12)
})

test('previewSignal writes nothing to the database', async () => {
  const deps = mockDeps()
  const marker = `preview-ok-${Date.now()}-${Math.random()}`
  const signal = buildManualInvestSignal({ ticker: 'AAPL', direction: 'buy', origin: 'pipeline', rationale: marker })
  const preview = await previewSignal(signal, {
    onlyFund: FUND.name,
    requestedNotionalUsd: 50,
    _funds: [FUND],
    _deps: deps,
  })
  assert.equal(preview.approved, true)
  assert.equal(preview.notionalUsd, 50)
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM signals WHERE rationale = ?`).get(marker).n, 0)
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM decisions WHERE reason LIKE ?`).get(`%${marker}%`).n, 0)
})

test('confirmInvest persists manual source and respects notional cap', async () => {
  const deps = mockDeps()
  let signalId = null
  try {
    const result = await confirmInvest(
      {
        ticker: 'AAPL',
        direction: 'buy',
        fund: FUND.name,
        notionalUsd: 500,
        origin: { kind: 'backtest', backtestId: 99 },
      },
      { _funds: [FUND], _deps: deps }
    )
    signalId = result.outcomes[0].signalId
    assert.equal(result.outcomes[0].approved, true)
    assert.equal(result.outcomes[0].notionalUsd, 100) // capped by fund max
    const row = db.prepare(`SELECT source, raw_reference FROM signals WHERE id = ?`).get(signalId)
    assert.equal(row.source, 'manual')
    const raw = JSON.parse(row.raw_reference)
    assert.equal(raw.origin.kind, 'backtest')
    assert.equal(raw.origin.backtestId, 99)
  } finally {
    cleanup(signalId)
  }
})

test('previewInvest rejects closed market without writing rows', async () => {
  const deps = mockDeps({ marketOpen: false })
  const marker = `preview-closed-${Date.now()}-${Math.random()}`
  const preview = await previewInvest(
    { ticker: 'AAPL', direction: 'buy', fund: FUND.name, origin: 'intel', rationale: marker },
    { _funds: [FUND], _deps: deps }
  )
  assert.equal(preview.approved, false)
  assert.match(preview.reason, /market is closed/)
  const written = db.prepare(`SELECT COUNT(*) AS n FROM signals WHERE rationale = ?`).get(marker).n
  assert.equal(written, 0)
})

test('processSignal with requestedNotionalUsd sizes down', async () => {
  const deps = mockDeps()
  let signalId = null
  try {
    const signal = buildManualInvestSignal({ ticker: 'AAPL', direction: 'buy', origin: 'manual' })
    const [outcome] = await processSignal(signal, {
      onlyFund: FUND.name,
      requestedNotionalUsd: 40,
      _funds: [FUND],
      _deps: deps,
    })
    signalId = outcome.signalId
    assert.equal(outcome.notionalUsd, 40)
  } finally {
    cleanup(signalId)
  }
})

test('promoteStrategyFromResearch creates strategy and warns on legacy routing', () => {
  let id = null
  try {
    const result = promoteStrategyFromResearch({
      name: 'Invest promote test',
      mode: 'manual',
      fund: 'paper',
      notionalUsd: 250,
      from: { kind: 'congress-backtest', politician: 'Test Politician' },
    })
    id = result.strategy.id
    assert.equal(result.strategy.definition.filters.politicians[0], 'Test Politician')
    assert.equal(result.strategy.definition.action.mode, 'manual')
    assert.equal(result.routing, config.signals.routing)
    if (config.signals.routing !== 'strategies') {
      assert.match(result.routingWarning, /SIGNAL_ROUTING/)
    } else {
      assert.equal(result.routingWarning, null)
    }
  } finally {
    if (id) deleteStrategy(id)
  }
})

test('promote rejects tweet/youtube kinds', () => {
  assert.throws(
    () => promoteStrategyFromResearch({ from: { kind: 'youtube-backtest' }, fund: 'paper', mode: 'manual' }),
    /congress and strategy/
  )
})

test('promote from existing strategy clones filters', () => {
  let sourceId = null
  let promotedId = null
  try {
    const source = createStrategy({
      name: 'Source strategy for promote',
      enabled: false,
      definition: {
        source: 'congress',
        filters: { politicians: ['Ada'], minCopyScore: 70 },
        action: { mode: 'watch', fund: 'paper', notionalUsd: 100 },
      },
    })
    sourceId = source.id
    const result = promoteStrategyFromResearch({
      name: 'Cloned promote',
      mode: 'manual',
      fund: 'paper',
      from: { kind: 'strategy-backtest', strategyId: sourceId },
    })
    promotedId = result.strategy.id
    assert.deepEqual(result.strategy.definition.filters.politicians, ['Ada'])
    assert.equal(result.strategy.definition.filters.minCopyScore, 70)
    assert.equal(result.strategy.definition.action.mode, 'manual')
  } finally {
    if (promotedId) deleteStrategy(promotedId)
    if (sourceId) deleteStrategy(sourceId)
  }
})
