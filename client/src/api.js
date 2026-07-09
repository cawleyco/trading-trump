async function req(path, options) {
  const resp = await fetch(path, options)
  const contentType = resp.headers.get('content-type') || ''
  const data = contentType.includes('application/json') ? await resp.json() : await resp.text()
  if (!resp.ok) {
    const message = typeof data === 'object' && data?.error
      ? data.error
      : String(data || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
    throw new Error(message ? `HTTP ${resp.status}: ${message}` : `HTTP ${resp.status}`)
  }
  return data
}

export const api = {
  status: () => req('/api/status'),
  signals: (limit = 100) => req(`/api/signals?limit=${limit}`),
  auditSignal: (signalId) => req(`/api/audit/signal/${encodeURIComponent(signalId)}`),
  auditOrder: (orderId) => req(`/api/audit/order/${encodeURIComponent(orderId)}`),
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
  politicianStats: (limit = 500) => req(`/api/intel/politicians?limit=${limit}`),
  politicianProfile: (name) => req(`/api/intel/politicians/${encodeURIComponent(name)}`),
  refreshPoliticianStats: () =>
    req('/api/intel/refresh-stats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }),
  refreshGraph: () =>
    req('/api/intel/refresh-graph', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }),
  tradeGraph: (tradeKey) => req(`/api/intel/graph/${encodeURIComponent(tradeKey)}`),
  crossSignal: (postId) => req(`/api/intel/cross-signal/${encodeURIComponent(postId)}`),
  politicianGraph: (name) => req(`/api/intel/politicians/${encodeURIComponent(name)}/graph`),
  drift: (tradeKey) => req(`/api/intel/drift/${encodeURIComponent(tradeKey)}`),
  trades: (params = {}) => {
    const qs = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') qs.set(key, value)
    }
    return req(`/api/intel/trades?${qs.toString()}`)
  },
  events: (params = {}) => {
    const qs = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') qs.set(key, value)
    }
    return req(`/api/intel/events?${qs.toString()}`)
  },
  refreshEvents: (body = {}) =>
    req('/api/intel/events/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  scoreTrade: (tradeKey) =>
    req(`/api/intel/score/${encodeURIComponent(tradeKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }),
  thesisCard: (tradeKey, force = false) =>
    req(`/api/intel/card/${encodeURIComponent(tradeKey)}${force ? '?force=true' : ''}`),
  reviewQueue: (status = 'pending') => req(`/api/review-queue?status=${status}`),
  resolveReview: (id, status) =>
    req(`/api/review-queue/${id}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    }),
  strategies: () => req('/api/strategies'),
  createStrategy: (body) =>
    req('/api/strategies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  updateStrategy: (id, body) =>
    req(`/api/strategies/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  deleteStrategy: (id) =>
    req(`/api/strategies/${id}`, { method: 'DELETE' }),
  strategyMatches: (id) => req(`/api/strategies/${id}/matches`),
  runStrategyBacktest: (id, body) =>
    req(`/api/strategies/${id}/backtest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  approvals: (status = 'pending') => req(`/api/approvals?status=${status}`),
  approveStrategy: (id) =>
    req(`/api/approvals/${id}/approve`, { method: 'POST' }),
  rejectStrategy: (id) =>
    req(`/api/approvals/${id}/reject`, { method: 'POST' }),
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
  youtubeDashboard: () => req('/api/influence/youtube/dashboard'),
  youtubeChannels: () => req('/api/influence/youtube/channels'),
  youtubeChannel: (id) => req(`/api/influence/youtube/channels/${id}`),
  createYoutubeChannel: (body) =>
    req('/api/influence/youtube/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  updateYoutubeChannel: (id, body) =>
    req(`/api/influence/youtube/channels/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  syncYoutubeChannel: (id, body = {}) =>
    req(`/api/influence/youtube/channels/${id}/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  recalculateYoutubeAlpha: (id) =>
    req(`/api/influence/youtube/channels/${id}/recalculate-alpha`, { method: 'POST' }),
  youtubeVideos: (channelId) =>
    req(`/api/influence/youtube/videos${channelId ? `?channelId=${encodeURIComponent(channelId)}` : ''}`),
  youtubeVideo: (id) => req(`/api/influence/youtube/videos/${id}`),
  createYoutubeVideo: (body) =>
    req('/api/influence/youtube/videos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  uploadYoutubeTranscript: (id, body) =>
    req(`/api/influence/youtube/videos/${id}/transcript`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  analyzeYoutubeVideo: (id) =>
    req(`/api/influence/youtube/videos/${id}/analyze`, { method: 'POST' }),
  generateYoutubeSignals: (id) =>
    req(`/api/influence/youtube/videos/${id}/signals`, { method: 'POST' }),
  youtubeMentions: (params = {}) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '')).toString()
    return req(`/api/influence/youtube/mentions${qs ? `?${qs}` : ''}`)
  },
  classifyYoutubeMention: (id) =>
    req(`/api/influence/youtube/mentions/${id}/reclassify`, { method: 'POST' }),
  overrideYoutubeMention: (id, body) =>
    req(`/api/influence/youtube/mentions/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  youtubeBacktests: () => req('/api/influence/youtube/backtests'),
  runYoutubeBacktest: (body) =>
    req('/api/influence/youtube/backtests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  youtubeBacktest: (id) => req(`/api/influence/youtube/backtests/${id}`),
  influenceSignals: (moduleKey = 'youtube') => req(`/api/influence/signals?moduleKey=${encodeURIComponent(moduleKey)}`),
}
