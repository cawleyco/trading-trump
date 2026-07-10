// Print compute_cache contents per namespace/version without starting the server.
import { defaultCache } from '../server/cache/computeCache.js';

const cache = await defaultCache();
const { persisted } = cache.stats();
if (persisted.length === 0) {
  console.log('compute_cache is empty');
  process.exit(0);
}
console.log('namespace            version  rows     bytes        persisted hits');
for (const r of persisted) {
  console.log(
    `${r.namespace.padEnd(20)} ${String(r.version).padEnd(8)} ${String(r.rows).padEnd(8)} ${String(r.bytes ?? 0).padEnd(12)} ${r.persistedHits ?? 0}`
  );
}
