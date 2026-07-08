import test from 'node:test'
import assert from 'node:assert/strict'
import { sicToSector, SECTORS } from '../server/lib/sicSectors.js'
import { overrideFor, resolveWithPrecedence } from '../server/lib/tickerOverrides.js'

test('sicToSector maps representative codes to the right buckets', () => {
  const cases = [
    ['3721', 'defense-aerospace'], // aircraft
    ['3761', 'defense-aerospace'], // guided missiles
    ['2836', 'healthcare'],        // biologicals
    ['3841', 'healthcare'],        // medical devices
    ['8011', 'healthcare'],        // health services
    ['6022', 'financials'],        // banks
    ['6798', 'real-estate'],       // REIT
    ['6500', 'real-estate'],
    ['1311', 'energy'],            // oil & gas
    ['2911', 'energy'],            // refining
    ['4911', 'utilities'],
    ['4813', 'communications'],    // telephone
    ['7812', 'communications'],    // movies
    ['3674', 'technology'],        // semiconductors
    ['7372', 'technology'],        // software
    ['3571', 'technology'],        // computers
    ['1040', 'materials'],         // gold mining
    ['2821', 'materials'],         // plastics/chemicals
    ['3559', 'industrials'],       // machinery
    ['4512', 'industrials'],       // airlines
    ['2000', 'consumer'],          // food
    ['5411', 'consumer'],          // grocery
    ['8742', 'other'],             // management consulting
  ]
  for (const [sic, sector] of cases) {
    assert.equal(sicToSector(sic), sector, `SIC ${sic}`)
  }
})

test('sicToSector accepts numbers, rejects garbage, and every result is a known bucket', () => {
  assert.equal(sicToSector(7372), 'technology')
  assert.equal(sicToSector('n/a'), null)
  assert.equal(sicToSector(null), null)
  assert.equal(sicToSector(''), null)
  assert.equal(sicToSector(-5), null)
  for (let sic = 100; sic < 10000; sic += 7) {
    const sector = sicToSector(sic)
    assert.ok(SECTORS.includes(sector), `SIC ${sic} → ${sector}`)
  }
})

test('overrideFor normalizes names', () => {
  assert.equal(overrideFor('Alphabet Inc'), 'GOOGL')
  assert.equal(overrideFor('alphabet, inc.'), 'GOOGL')
  assert.equal(overrideFor('  META   PLATFORMS  '), 'META')
  assert.equal(overrideFor('Some Unknown Corp'), null)
})

test('resolution precedence: override beats ticker match beats name match', () => {
  const lookups = {
    byTicker: (t) => (t === 'AAPL' ? 'AAPL' : null),
    byName: (n) => (n.toLowerCase().includes('apple') ? 'AAPL' : null),
  }
  // Override wins even when other lookups would also match
  assert.equal(
    resolveWithPrecedence('Alphabet Inc', {
      byTicker: () => 'WRONG',
      byName: () => 'WRONG',
    }),
    'GOOGL'
  )
  // Exact ticker match (case-insensitive input)
  assert.equal(resolveWithPrecedence('aapl', lookups), 'AAPL')
  // Falls back to company-name match
  assert.equal(resolveWithPrecedence('Apple Inc', lookups), 'AAPL')
  // Nothing matches → null
  assert.equal(resolveWithPrecedence('Nonexistent Co', lookups), null)
  assert.equal(resolveWithPrecedence('', lookups), null)
  assert.equal(resolveWithPrecedence(null, lookups), null)
})
