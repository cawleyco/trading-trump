import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateStrategyDefinition,
  validateStrategyDefinition,
} from '../server/intel/strategyEngine.js';

const trade = {
  trade_key: 'Jane Doe|ABC|2026-07-01|buy|$50,001 - $100,000',
  politician: 'Jane Doe',
  ticker: 'ABC',
  type: 'buy',
  transaction_date: '2026-07-01',
  disclosure_date: '2026-07-04',
  amount_mid: 75_000,
};

const score = {
  score: 84,
  confidence: 0.72,
  recommendation: 'copy-candidate',
  factors: {
    cluster: { score: 75, detail: '3 distinct politicians traded ABC buy within 30 days.' },
    committeeRelevance: { score: 68, detail: 'Committee sector match.' },
    politicianEdge: { score: 82, detail: 'Strong edge.' },
  },
  warnings: [{ code: 'low-conviction', severity: 'caution' }],
};

test('validateStrategyDefinition rejects unknown keys and normalizes optional filters', () => {
  assert.throws(
    () => validateStrategyDefinition({ source: 'congress', filters: { bogus: true }, action: { mode: 'watch' } }),
    /unknown filter keys: bogus/
  );

  const clean = validateStrategyDefinition({
    source: 'congress',
    filters: { minCopyScore: '80', politicians: ['Jane Doe', ''] },
    action: { mode: 'manual', notionalUsd: '500' },
  });
  assert.equal(clean.filters.minCopyScore, 80);
  assert.deepEqual(clean.filters.politicians, ['Jane Doe']);
  assert.equal(clean.action.notionalUsd, 500);
});

test('evaluateStrategyDefinition matches combined filters from trade and score context', () => {
  const result = evaluateStrategyDefinition(trade, score, {
    source: 'congress',
    filters: {
      direction: 'buy',
      minCopyScore: 80,
      minConfidence: 0.6,
      maxDisclosureLagDays: 10,
      minClusterCount: 3,
      minRelevanceScore: 50,
      minEdgeScore: 75,
      politicians: ['Jane Doe'],
      excludeWarnings: ['illiquid'],
    },
    action: { mode: 'watch' },
  });

  assert.equal(result.matched, true);
  assert.deepEqual(result.failedFilters, []);
});

test('evaluateStrategyDefinition reports every failed filter for explainability', () => {
  const result = evaluateStrategyDefinition(trade, score, {
    source: 'congress',
    filters: {
      direction: 'sell',
      minCopyScore: 90,
      maxDisclosureLagDays: 1,
      excludeWarnings: ['low-conviction'],
      minAmountMid: 100_000,
    },
    action: { mode: 'watch' },
  });

  assert.equal(result.matched, false);
  assert.deepEqual(result.failedFilters.map((f) => f.code), [
    'direction',
    'minCopyScore',
    'maxDisclosureLagDays',
    'excludeWarnings',
    'minAmountMid',
  ]);
});

test('seed strategy definitions hit their intended filters', () => {
  const freshHighConviction = {
    source: 'congress',
    filters: { direction: 'buy', minCopyScore: 80, maxDisclosureLagDays: 10 },
    action: { mode: 'manual', fund: 'paper', notionalUsd: 500 },
  };
  const clusterAccumulation = {
    source: 'congress',
    filters: { direction: 'buy', minClusterCount: 3 },
    action: { mode: 'watch' },
  };

  assert.equal(evaluateStrategyDefinition(trade, score, freshHighConviction).matched, true);
  assert.equal(evaluateStrategyDefinition(trade, score, clusterAccumulation).matched, true);
});
