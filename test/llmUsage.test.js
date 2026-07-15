import test from 'node:test'
import assert from 'node:assert/strict'
import {
  logLlmUsage,
  llmUsageTotals,
  llmUsageRecent,
  llmUsageCallCount,
  _resetLlmUsage,
} from '../server/lib/llmUsage.js'

test.beforeEach(() => {
  _resetLlmUsage()
})

test('logLlmUsage records subject into recent and accumulates totals', () => {
  logLlmUsage('youtube-classifier', {
    input_tokens: 100,
    output_tokens: 20,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 5,
  }, { channel: 'Foo', video: 'Bar', asset: 'AAPL' })

  assert.equal(llmUsageCallCount(), 1)
  assert.deepEqual(llmUsageTotals()['youtube-classifier'], {
    calls: 1,
    inputTokens: 100,
    outputTokens: 20,
    cacheCreationTokens: 0,
    cacheReadTokens: 5,
  })

  const recent = llmUsageRecent()
  assert.equal(recent.length, 1)
  assert.equal(recent[0].tag, 'youtube-classifier')
  assert.deepEqual(recent[0].subject, { channel: 'Foo', video: 'Bar', asset: 'AAPL' })
  assert.equal(recent[0].input_tokens, 100)
  assert.equal(recent[0].output_tokens, 20)
  assert.ok(recent[0].ts)
})

test('logLlmUsage skips empty subject fields and ignores missing usage', () => {
  logLlmUsage('sentiment-classifier', null, { preview: 'x' })
  assert.equal(llmUsageCallCount(), 0)
  assert.deepEqual(llmUsageRecent(), [])

  logLlmUsage('sentiment-classifier', { input_tokens: 10, output_tokens: 2 }, {
    preview: 'Hello world',
    empty: '',
    missing: null,
  })
  assert.deepEqual(llmUsageRecent()[0].subject, { preview: 'Hello world' })
})

test('recent ring drops oldest entries past 50', () => {
  for (let i = 0; i < 55; i += 1) {
    logLlmUsage('thesis-polish', { input_tokens: 1, output_tokens: 1 }, {
      tradeKey: `t-${i}`,
      ticker: 'X',
    })
  }
  const recent = llmUsageRecent()
  assert.equal(recent.length, 50)
  assert.equal(recent[0].subject.tradeKey, 't-54')
  assert.equal(recent[49].subject.tradeKey, 't-5')
  assert.equal(llmUsageCallCount(), 55)
  assert.equal(llmUsageTotals()['thesis-polish'].calls, 55)
})

test('newest calls appear first across tags', () => {
  logLlmUsage('sentiment-classifier', { input_tokens: 1, output_tokens: 1 }, { preview: 'first' })
  logLlmUsage('youtube-classifier', { input_tokens: 2, output_tokens: 2 }, { asset: 'MSFT' })
  const tags = llmUsageRecent().map((e) => e.tag)
  assert.deepEqual(tags, ['youtube-classifier', 'sentiment-classifier'])
})
