async function req(path, options) {
  const resp = await fetch(path, options)
  const data = await resp.json()
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`)
  return data
}

export const api = {
  status: () => req('/api/status'),
  signals: (limit = 100) => req(`/api/signals?limit=${limit}`),
  attribution: () => req('/api/attribution'),
  halt: (reason, fund) =>
    req('/api/halt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason, fund }),
    }),
  resume: (fund) =>
    req('/api/resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fund }),
    }),
  testSignal: (body) =>
    req('/api/test-signal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  filingSpeed: (minTrades = 3) => req(`/api/intel/filing-speed?minTrades=${minTrades}`),
  drift: (tradeKey) => req(`/api/intel/drift/${encodeURIComponent(tradeKey)}`),
  reviewQueue: (status = 'pending') => req(`/api/review-queue?status=${status}`),
  resolveReview: (id, status) =>
    req(`/api/review-queue/${id}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    }),
  politicians: () => req('/api/politicians'),
  backtests: () => req('/api/backtests'),
  backtest: (id) => req(`/api/backtests/${id}`),
  runCongressBacktest: (body) =>
    req('/api/backtests/congress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  compareEntryBasis: (body) =>
    req('/api/backtests/congress/compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  runTweetBacktest: (body) =>
    req('/api/backtests/tweet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  runLeaderboard: (body) =>
    req('/api/backtests/congress-leaderboard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  runWalkForward: (body) =>
    req('/api/backtests/walk-forward', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
}
