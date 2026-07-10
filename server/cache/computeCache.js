// Persistent compute cache: get-or-compute memoization backed by SQLite.
//
// Any expensive calculation (market bars, aggregations, LLM outputs) can be
// keyed by its canonicalized inputs and stored in the compute_cache table so
// it is never recomputed — across requests and across restarts. Call sites
// only touch the memoize/get/set/invalidate API, so a future server
// deployment can swap the SQLite backing for Redis/Postgres without
// changing callers.
//
// Keying: sha256 of canonical (sorted-key) JSON of [namespace, version,
// keyParts]. `version` also lives in its own column so a whole generation
// can be purged after an algorithm change.
//
// TTL: expires_at NULL means the value is immutable and never expires
// (e.g. historical bars whose range ended before today). Failures are never
// cached: the default shouldCache rejects null/undefined, matching
// marketData.js semantics.

import crypto from 'node:crypto';

const DDL = `
CREATE TABLE IF NOT EXISTS compute_cache (
  namespace TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  key_json TEXT,
  value_json TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '1',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  hit_count INTEGER NOT NULL DEFAULT 0,
  last_hit_at TEXT,
  PRIMARY KEY (namespace, key_hash)
);
CREATE INDEX IF NOT EXISTS idx_compute_cache_expires ON compute_cache(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_compute_cache_ns ON compute_cache(namespace, version);
`;

/** Canonical JSON: object keys sorted recursively so key order never matters. */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  const parts = keys
    .filter((k) => value[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`);
  return `{${parts.join(',')}}`;
}

export function stableHash(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

const KEY_JSON_MAX = 4096; // skip storing huge debug keys

export function createComputeCache(db, { now = Date.now } = {}) {
  db.exec(DDL);

  const stmts = {
    get: db.prepare(
      `SELECT value_json, expires_at FROM compute_cache WHERE namespace = ? AND key_hash = ?`
    ),
    upsert: db.prepare(
      `INSERT INTO compute_cache (namespace, key_hash, key_json, value_json, version, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (namespace, key_hash) DO UPDATE SET
         key_json = excluded.key_json,
         value_json = excluded.value_json,
         version = excluded.version,
         created_at = excluded.created_at,
         expires_at = excluded.expires_at`
    ),
    touch: db.prepare(
      `UPDATE compute_cache SET hit_count = hit_count + 1, last_hit_at = ? WHERE namespace = ? AND key_hash = ?`
    ),
    del: db.prepare(`DELETE FROM compute_cache WHERE namespace = ? AND key_hash = ?`),
    purgeExpired: db.prepare(`DELETE FROM compute_cache WHERE expires_at IS NOT NULL AND expires_at < ?`),
    purgeNamespace: db.prepare(`DELETE FROM compute_cache WHERE namespace = ?`),
    purgeOldVersions: db.prepare(`DELETE FROM compute_cache WHERE namespace = ? AND version <> ?`),
    stats: db.prepare(
      `SELECT namespace, version, COUNT(*) AS rows_, SUM(LENGTH(value_json)) AS bytes, SUM(hit_count) AS persisted_hits
         FROM compute_cache GROUP BY namespace, version ORDER BY namespace, version`
    ),
  };

  const inflight = new Map(); // `${ns}:${hash}` → Promise
  const counters = new Map(); // ns → { hits, misses, writes }

  function count(namespace, field) {
    let c = counters.get(namespace);
    if (!c) counters.set(namespace, (c = { hits: 0, misses: 0, writes: 0 }));
    c[field] += 1;
  }

  function nowIso() {
    return new Date(now()).toISOString();
  }

  function hashKey(namespace, keyParts, version) {
    return stableHash([namespace, String(version), keyParts]);
  }

  function readRow(namespace, keyHash) {
    const row = stmts.get.get(namespace, keyHash);
    if (!row) return null;
    if (row.expires_at !== null && row.expires_at < nowIso()) return null; // stale; purge sweeps later
    return row;
  }

  function get(namespace, keyParts, { version = '1' } = {}) {
    const keyHash = hashKey(namespace, keyParts, version);
    const row = readRow(namespace, keyHash);
    if (!row) {
      count(namespace, 'misses');
      return { hit: false };
    }
    stmts.touch.run(nowIso(), namespace, keyHash);
    count(namespace, 'hits');
    return { hit: true, value: JSON.parse(row.value_json) };
  }

  function set(namespace, keyParts, value, { ttlMs = null, version = '1' } = {}) {
    const keyHash = hashKey(namespace, keyParts, version);
    const keyJson = stableStringify(keyParts);
    const expiresAt = ttlMs == null ? null : new Date(now() + ttlMs).toISOString();
    stmts.upsert.run(
      namespace,
      keyHash,
      keyJson.length <= KEY_JSON_MAX ? keyJson : null,
      JSON.stringify(value),
      String(version),
      nowIso(),
      expiresAt
    );
    count(namespace, 'writes');
    return value;
  }

  const defaultShouldCache = (value) => value !== null && value !== undefined;

  // ttlMs may be a function of the computed value (e.g. historical data →
  // never expires, live-edge or empty data → short TTL).
  function resolveTtl(ttlMs, value) {
    return typeof ttlMs === 'function' ? ttlMs(value) : ttlMs;
  }

  async function memoize(namespace, keyParts, computeFn, opts = {}) {
    const { ttlMs = null, version = '1', force = false, shouldCache = defaultShouldCache } = opts;
    const keyHash = hashKey(namespace, keyParts, version);

    if (!force) {
      const row = readRow(namespace, keyHash);
      if (row) {
        stmts.touch.run(nowIso(), namespace, keyHash);
        count(namespace, 'hits');
        return JSON.parse(row.value_json);
      }
      const pending = inflight.get(`${namespace}:${keyHash}`);
      if (pending) return pending;
    }
    count(namespace, 'misses');

    const promise = (async () => {
      const value = await computeFn();
      if (shouldCache(value)) set(namespace, keyParts, value, { ttlMs: resolveTtl(ttlMs, value), version });
      return value;
    })();
    inflight.set(`${namespace}:${keyHash}`, promise);
    try {
      return await promise;
    } finally {
      inflight.delete(`${namespace}:${keyHash}`);
    }
  }

  /** Like memoize but for synchronous computeFns (no single-flight needed). */
  function memoizeSync(namespace, keyParts, computeFn, opts = {}) {
    const { ttlMs = null, version = '1', force = false, shouldCache = defaultShouldCache } = opts;
    if (!force) {
      const hit = get(namespace, keyParts, { version });
      if (hit.hit) return hit.value;
    } else {
      count(namespace, 'misses');
    }
    const value = computeFn();
    if (shouldCache(value)) set(namespace, keyParts, value, { ttlMs: resolveTtl(ttlMs, value), version });
    return value;
  }

  return {
    memoize,
    memoizeSync,
    get,
    set,
    invalidate(namespace, keyParts, { version = '1' } = {}) {
      return stmts.del.run(namespace, hashKey(namespace, keyParts, version)).changes;
    },
    purgeExpired() {
      return stmts.purgeExpired.run(nowIso()).changes;
    },
    purgeNamespace(namespace, { keepVersion } = {}) {
      return keepVersion != null
        ? stmts.purgeOldVersions.run(namespace, String(keepVersion)).changes
        : stmts.purgeNamespace.run(namespace).changes;
    },
    stats() {
      const persisted = stmts.stats.all().map((r) => ({
        namespace: r.namespace,
        version: r.version,
        rows: r.rows_,
        bytes: r.bytes,
        persistedHits: r.persisted_hits,
      }));
      const session = Object.fromEntries(counters);
      return { persisted, session };
    },
  };
}

// Default instance bound to the app database. Lazy so unit tests can use
// createComputeCache(new Database(':memory:')) without importing config.js.
let _default = null;
export async function defaultCache() {
  if (!_default) {
    const { db } = await import('../db.js');
    _default = createComputeCache(db);
  }
  return _default;
}
