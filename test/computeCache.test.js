import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { createComputeCache, stableStringify, stableHash } from '../server/cache/computeCache.js'

function makeCache(startMs = 1_700_000_000_000) {
  const clock = { now: startMs }
  const cache = createComputeCache(new Database(':memory:'), { now: () => clock.now })
  return { cache, clock }
}

test('stableStringify is key-order independent and round-trips scalars', () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }))
  assert.equal(stableStringify({ a: { y: 1, x: [3, null] } }), '{"a":{"x":[3,null],"y":1}}')
  assert.equal(stableStringify('s'), '"s"')
  assert.equal(stableStringify(null), 'null')
  assert.equal(stableStringify(7.5), '7.5')
  assert.notEqual(stableHash({ a: 1 }), stableHash({ a: 2 }))
  assert.equal(stableHash({ b: 1, a: 2 }), stableHash({ a: 2, b: 1 }))
})

test('memoize computes once and serves hits from the store', async () => {
  const { cache } = makeCache()
  let calls = 0
  const compute = async () => { calls += 1; return { n: calls } }
  assert.deepEqual(await cache.memoize('ns', { k: 1 }, compute), { n: 1 })
  assert.deepEqual(await cache.memoize('ns', { k: 1 }, compute), { n: 1 })
  assert.equal(calls, 1)
})

test('force recomputes and overwrites', async () => {
  const { cache } = makeCache()
  let calls = 0
  const compute = async () => { calls += 1; return calls }
  assert.equal(await cache.memoize('ns', 'k', compute), 1)
  assert.equal(await cache.memoize('ns', 'k', compute, { force: true }), 2)
  assert.equal(await cache.memoize('ns', 'k', compute), 2)
  assert.equal(calls, 2)
})

test('entries expire after ttlMs; ttlMs null never expires', async () => {
  const { cache, clock } = makeCache()
  let calls = 0
  const compute = async () => { calls += 1; return calls }
  await cache.memoize('ttl', 'k', compute, { ttlMs: 1000 })
  clock.now += 999
  assert.equal(await cache.memoize('ttl', 'k', compute, { ttlMs: 1000 }), 1)
  clock.now += 2
  assert.equal(await cache.memoize('ttl', 'k', compute, { ttlMs: 1000 }), 2)

  await cache.memoize('immutable', 'k', compute, { ttlMs: null })
  clock.now += 10 * 365 * 86_400_000
  assert.equal(await cache.memoize('immutable', 'k', compute, { ttlMs: null }), 3)
  assert.equal(calls, 3)
})

test('ttlMs may be a function of the computed value', async () => {
  const { cache, clock } = makeCache()
  let value = []
  const compute = async () => value
  const ttlMs = (v) => (v.length === 0 ? 1000 : null)
  assert.deepEqual(await cache.memoize('fn-ttl', 'k', compute, { ttlMs }), [])
  clock.now += 1001
  value = [1, 2]
  assert.deepEqual(await cache.memoize('fn-ttl', 'k', compute, { ttlMs }), [1, 2])
  clock.now += 10 * 365 * 86_400_000
  assert.deepEqual(await cache.memoize('fn-ttl', 'k', compute, { ttlMs }), [1, 2])
})

test('version bump is a miss; purgeNamespace keepVersion drops old generations', async () => {
  const { cache } = makeCache()
  let calls = 0
  const compute = async () => { calls += 1; return calls }
  assert.equal(await cache.memoize('v', 'k', compute, { version: 1 }), 1)
  assert.equal(await cache.memoize('v', 'k', compute, { version: 2 }), 2)
  assert.equal(calls, 2)
  assert.equal(cache.purgeNamespace('v', { keepVersion: 2 }), 1)
  assert.equal(cache.purgeNamespace('v'), 1)
})

test('null/undefined results are returned but never cached by default', async () => {
  const { cache } = makeCache()
  let calls = 0
  const compute = async () => { calls += 1; return calls < 2 ? null : 'ok' }
  assert.equal(await cache.memoize('nc', 'k', compute), null)
  assert.equal(await cache.memoize('nc', 'k', compute), 'ok')
  assert.equal(await cache.memoize('nc', 'k', compute), 'ok')
  assert.equal(calls, 2)
})

test('concurrent misses on the same key compute once (single-flight)', async () => {
  const { cache } = makeCache()
  let calls = 0
  const compute = () => new Promise((resolve) => {
    calls += 1
    setTimeout(() => resolve('v'), 10)
  })
  const [a, b] = await Promise.all([
    cache.memoize('sf', 'k', compute),
    cache.memoize('sf', 'k', compute),
  ])
  assert.equal(a, 'v')
  assert.equal(b, 'v')
  assert.equal(calls, 1)
})

test('memoizeSync mirrors memoize for synchronous compute fns', () => {
  const { cache } = makeCache()
  let calls = 0
  const compute = () => { calls += 1; return calls }
  assert.equal(cache.memoizeSync('sync', 'k', compute), 1)
  assert.equal(cache.memoizeSync('sync', 'k', compute), 1)
  assert.equal(cache.memoizeSync('sync', 'k', compute, { force: true }), 2)
  assert.equal(calls, 2)
})

test('get/set/invalidate round-trip', () => {
  const { cache } = makeCache()
  assert.deepEqual(cache.get('rt', { a: 1 }), { hit: false })
  cache.set('rt', { a: 1 }, { data: true })
  assert.deepEqual(cache.get('rt', { a: 1 }), { hit: true, value: { data: true } })
  assert.equal(cache.invalidate('rt', { a: 1 }), 1)
  assert.deepEqual(cache.get('rt', { a: 1 }), { hit: false })
})

test('purgeExpired deletes only stale rows; stats reports namespaces and counters', async () => {
  const { cache, clock } = makeCache()
  cache.set('p', 'stale', 1, { ttlMs: 1000 })
  cache.set('p', 'fresh', 2, { ttlMs: 1_000_000 })
  cache.set('p', 'forever', 3, { ttlMs: null })
  clock.now += 2000
  assert.equal(cache.purgeExpired(), 1)
  const { persisted, session } = cache.stats()
  assert.equal(persisted.length, 1)
  assert.equal(persisted[0].namespace, 'p')
  assert.equal(persisted[0].rows, 2)
  assert.ok(session.p.writes >= 3)
})
