import test from 'node:test'
import assert from 'node:assert/strict'
import { _reusablePolish } from '../server/intel/cardRunner.js'
import { stableHash } from '../server/cache/computeCache.js'

const HASH = stableHash({ card: { what: 'x' }, model: 'm', prompt: 'polish-v1' })

test('reuses the cached polish when the card hash matches', () => {
  const cached = { card_hash: HASH, polished: 'Analyst note.' }
  assert.equal(_reusablePolish(cached, HASH), 'Analyst note.')
})

test('re-polishes when the hash differs, the cache is empty, or force is set', () => {
  const cached = { card_hash: HASH, polished: 'Analyst note.' }
  assert.equal(_reusablePolish(cached, stableHash({ card: { what: 'y' }, model: 'm', prompt: 'polish-v1' })), null)
  assert.equal(_reusablePolish(null, HASH), null)
  assert.equal(_reusablePolish(undefined, HASH), null)
  assert.equal(_reusablePolish(cached, HASH, true), null)
})

test('does not treat a missing stored polish as reusable', () => {
  assert.equal(_reusablePolish({ card_hash: HASH, polished: null }, HASH), null)
  // pre-migration rows have card_hash NULL and never match
  assert.equal(_reusablePolish({ card_hash: null, polished: 'old note' }, HASH), null)
})

test('model or prompt version changes produce a different hash', () => {
  const card = { what: 'x' }
  assert.notEqual(
    stableHash({ card, model: 'm', prompt: 'polish-v1' }),
    stableHash({ card, model: 'm2', prompt: 'polish-v1' })
  )
  assert.notEqual(
    stableHash({ card, model: 'm', prompt: 'polish-v1' }),
    stableHash({ card, model: 'm', prompt: 'polish-v2' })
  )
})
