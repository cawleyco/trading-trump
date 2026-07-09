import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkAvgDollarVolume,
  checkBlockOptions,
  checkCooldown,
  checkMaxTradesPerDay,
  checkMinCopyScoreAuto,
  checkSectorExposure,
} from '../server/riskManager.js';

test('checkSectorExposure skips when unconfigured or sector metadata is missing', () => {
  assert.equal(checkSectorExposure({ equity: 1000 }).skipped, true);
  assert.equal(checkSectorExposure({ capPct: 20, equity: 1000 }).skipped, true);
});

test('checkSectorExposure includes existing same-sector exposure plus the proposed buy', () => {
  const result = checkSectorExposure({
    capPct: 25,
    tickerSector: 'technology',
    equity: 1000,
    buyNotionalUsd: 100,
    positions: [
      { symbol: 'MSFT', sector: 'technology', marketValue: 100 },
      { symbol: 'XOM', sector: 'energy', marketValue: 500 },
    ],
  });
  assert.equal(result.pass, true);
  assert.match(result.detail, /20\.00%/);

  const rejected = checkSectorExposure({
    capPct: 15,
    tickerSector: 'technology',
    equity: 1000,
    buyNotionalUsd: 100,
    positions: [{ symbol: 'MSFT', sector: 'technology', marketValue: 100 }],
  });
  assert.equal(rejected.pass, false);
});

test('checkAvgDollarVolume rejects missing or insufficient liquidity when configured', () => {
  assert.equal(checkAvgDollarVolume({ observed: 100 }).skipped, true);
  assert.equal(checkAvgDollarVolume({ minimum: 1000, observed: null }).pass, false);
  assert.equal(checkAvgDollarVolume({ minimum: 1000, observed: 999 }).pass, false);
  assert.equal(checkAvgDollarVolume({ minimum: 1000, observed: 1000 }).pass, true);
});

test('checkCooldown and checkMaxTradesPerDay enforce configured counts', () => {
  assert.equal(checkCooldown({ recentOrders: 3 }).skipped, true);
  assert.equal(checkCooldown({ cooldownMinutes: 60, recentOrders: 1 }).pass, false);
  assert.equal(checkCooldown({ cooldownMinutes: 60, recentOrders: 0 }).pass, true);

  assert.equal(checkMaxTradesPerDay({ tradesToday: 10 }).skipped, true);
  assert.equal(checkMaxTradesPerDay({ maxTradesPerDay: 3, tradesToday: 3 }).pass, false);
  assert.equal(checkMaxTradesPerDay({ maxTradesPerDay: 3, tradesToday: 2 }).pass, true);
});

test('checkBlockOptions defaults to blocking option source trades', () => {
  assert.equal(checkBlockOptions({ isOption: true }).pass, false);
  assert.equal(checkBlockOptions({ isOption: false }).pass, true);
  assert.equal(checkBlockOptions({ blockOptions: false, isOption: true }).skipped, true);
});

test('checkMinCopyScoreAuto only gates auto strategy signals', () => {
  assert.equal(checkMinCopyScoreAuto({ minimum: 80, mode: 'manual', copyScore: 10 }).skipped, true);
  assert.equal(checkMinCopyScoreAuto({ mode: 'auto', copyScore: 10 }).skipped, true);
  assert.equal(checkMinCopyScoreAuto({ minimum: 80, mode: 'auto', copyScore: 79 }).pass, false);
  assert.equal(checkMinCopyScoreAuto({ minimum: 80, mode: 'auto', copyScore: 80 }).pass, true);
});
