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
  politicians: () => req('/api/politicians'),
  backtests: () => req('/api/backtests'),
  backtest: (id) => req(`/api/backtests/${id}`),
  runCongressBacktest: (body) =>
    req('/api/backtests/congress', {
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
}
