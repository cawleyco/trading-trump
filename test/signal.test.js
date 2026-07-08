import test from 'node:test'
import assert from 'node:assert/strict'
import { makeTradeSignal } from '../server/signal.js'

test('accepts a valid buy signal and normalizes the ticker', () => {
  const s = makeTradeSignal({
    source: 'congress',
    ticker: ' nvda ',
    direction: 'buy',
    rationale: 'test',
  })
  assert.equal(s.ticker, 'NVDA')
  assert.equal(s.direction, 'buy')
  assert.equal(s.confidence, null)
})

test('rejects invalid sources, directions, tickers and confidence', () => {
  assert.throws(() => makeTradeSignal({ source: 'other', ticker: 'AAPL', direction: 'buy' }))
  assert.throws(() => makeTradeSignal({ source: 'congress', ticker: 'AAPL', direction: 'short' }))
  assert.throws(() => makeTradeSignal({ source: 'congress', ticker: '', direction: 'buy' }))
  assert.throws(() => makeTradeSignal({ source: 'congress', ticker: '123$', direction: 'buy' }))
  assert.throws(() =>
    makeTradeSignal({ source: 'sentiment', ticker: 'AAPL', direction: 'buy', confidence: 1.5 })
  )
})

test('allows dotted share classes like BRK.B', () => {
  const s = makeTradeSignal({ source: 'congress', ticker: 'BRK.B', direction: 'sell' })
  assert.equal(s.ticker, 'BRK.B')
})
