import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { assessTrade, detectOption, normalizeOwner } from '../server/lib/filingQuality.js'

const fixtures = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/congress-trades.json', import.meta.url)), 'utf8')
)

// A resolver that knows the common tickers; everything else is "unresolved".
const known = new Set(['AAPL', 'TSLA', 'NVDA', 'AMD', 'MSFT'])
const resolveTicker = (t) => (known.has(String(t).toUpperCase()) ? t : null)

test('a clean senate row scores 1.0 with no flags', () => {
  const r = assessTrade(fixtures.senateClean, { resolveTicker })
  assert.equal(r.parseConfidence, 1.0)
  assert.deepEqual(r.flags, [])
  assert.equal(r.owner, 'self')
  assert.equal(r.isOption, false)
})

test('missing transaction date deducts 0.3 and flags', () => {
  const r = assessTrade(
    { ...fixtures.senateClean, transactionDate: null },
    { resolveTicker }
  )
  assert.equal(r.parseConfidence, 0.7)
  assert.ok(r.flags.includes('missing-transaction-date'))
})

test('unparseable amount deducts 0.2 and flags', () => {
  const r = assessTrade({ ...fixtures.senateClean, amountRange: 'N/A' }, { resolveTicker })
  assert.equal(r.parseConfidence, 0.8)
  assert.ok(r.flags.includes('no-amount'))
})

test('unresolved ticker deducts 0.3 and flags', () => {
  const r = assessTrade({ ...fixtures.senateClean, ticker: 'ZZZZQ' }, { resolveTicker })
  assert.equal(r.parseConfidence, 0.7)
  assert.ok(r.flags.includes('unresolved-ticker'))
})

test('ticker check is skipped when no resolver is injected', () => {
  const r = assessTrade({ ...fixtures.senateClean, ticker: 'ZZZZQ' })
  assert.equal(r.parseConfidence, 1.0)
  assert.deepEqual(r.flags, [])
})

test('a parseable option extracts type/strike/expiry and is not flagged', () => {
  const r = assessTrade(fixtures.senateSpouseOption, { resolveTicker })
  assert.equal(r.isOption, true)
  assert.equal(r.optionDetail.type, 'call')
  assert.equal(r.optionDetail.strike, 300)
  assert.equal(r.optionDetail.expiry, '01/16/2027')
  assert.equal(r.owner, 'spouse')
  assert.ok(!r.flags.includes('unparsed-option'))
  assert.equal(r.parseConfidence, 1.0)
})

test('an option with no strike/expiry is flagged unparsed-option (-0.2)', () => {
  const r = assessTrade(fixtures.quiverUnparsedOption, { resolveTicker })
  assert.equal(r.isOption, true)
  assert.ok(r.flags.includes('unparsed-option'))
  assert.equal(r.parseConfidence, 0.8)
})

test('disclosure before transaction deducts 0.4 and flags date-inconsistency', () => {
  const r = assessTrade(fixtures.dateInconsistent, { resolveTicker })
  assert.ok(r.flags.includes('date-inconsistency'))
  assert.equal(r.parseConfidence, 0.6)
})

test('quiver Owner field is read (spouse)', () => {
  const r = assessTrade(fixtures.quiverClean, { resolveTicker })
  assert.equal(r.owner, 'spouse')
  assert.equal(r.parseConfidence, 1.0)
})

test('garbage row stacks deductions and clamps at 0', () => {
  const r = assessTrade(fixtures.garbage, { resolveTicker })
  // missing txn date (-0.3) + no amount (-0.2) + unresolved ticker (-0.3) = 0.2
  assert.equal(r.parseConfidence, 0.2)
  assert.equal(r.owner, 'dependent')
  assert.ok(r.flags.includes('missing-transaction-date'))
  assert.ok(r.flags.includes('no-amount'))
  assert.ok(r.flags.includes('unresolved-ticker'))
})

test('detectOption distinguishes puts, calls, and non-options', () => {
  assert.equal(detectOption('Apple Inc common stock').isOption, false)
  assert.equal(detectOption('SPY put option $400').optionDetail.type, 'put')
  assert.equal(detectOption('bare option contract').hasDetail, false)
})

test('normalizeOwner maps the common variants', () => {
  assert.equal(normalizeOwner('Self'), 'self')
  assert.equal(normalizeOwner('Joint'), 'self')
  assert.equal(normalizeOwner('Spouse'), 'spouse')
  assert.equal(normalizeOwner('Dependent Child'), 'dependent')
  assert.equal(normalizeOwner('DC'), 'dependent')
  assert.equal(normalizeOwner(''), null)
  assert.equal(normalizeOwner(null), null)
})
