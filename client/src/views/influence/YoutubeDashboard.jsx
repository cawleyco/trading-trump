import { useEffect, useState } from 'react'
import { api } from '../../api.js'
import { StatCard } from './InfluenceLayout.jsx'
import { card, muted, navigate } from './ui.js'

export default function YoutubeDashboard() {
  const [stats, setStats] = useState(null)
  const [signals, setSignals] = useState([])
  const [error, setError] = useState(null)

  useEffect(() => {
    api.youtubeDashboard().then(setStats).catch((e) => setError(e.message))
    api.influenceSignals('youtube').then(setSignals).catch(() => {})
  }, [])

  if (error) return <section style={card}><h3>YouTube Dashboard</h3><p style={{ color: '#fca5a5' }}>{error}</p></section>
  if (!stats) return <p>Loading Influence Signals…</p>

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <StatCard label="Videos analyzed today" value={stats.videosAnalyzedToday} />
        <StatCard label="New asset mentions" value={stats.newAssetMentions} />
        <StatCard label="Bullish high-quality" value={stats.highQualityBullishMentions} />
        <StatCard label="Bearish high-quality" value={stats.highQualityBearishMentions} />
        <StatCard label="High pump-risk" value={stats.highPumpRiskMentions} />
      </div>

      <section style={card}>
        <h3>Tracked YouTube Creators</h3>
        <p style={muted}>Start with manually added finance/crypto channels, then sync metadata when `YOUTUBE_API_KEY` is configured.</p>
        <button onClick={() => navigate('/app/influence/youtube/channels')}>Manage channels</button>
      </section>

      <section style={card}>
        <h3>Assets Trending Across YouTube</h3>
        {stats.trendingAssets.length === 0 ? (
          <p style={muted}>No detected mentions yet.</p>
        ) : (
          <table>
            <thead><tr><th>Asset</th><th>Name</th><th>Mentions</th></tr></thead>
            <tbody>
              {stats.trendingAssets.map((a) => (
                <tr key={a.id}><td>{a.symbol}</td><td>{a.canonical_name}</td><td>{a.mentions}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section style={card}>
        <h3>Research Signal Feed</h3>
        {signals.length === 0 ? (
          <p style={muted}>No influence research signals yet. Live trading integration remains disabled.</p>
        ) : (
          <table>
            <thead><tr><th>Time</th><th>Asset</th><th>Direction</th><th>Action</th><th>Why</th></tr></thead>
            <tbody>
              {signals.slice(0, 8).map((s) => (
                <tr key={s.id}>
                  <td>{s.created_at}</td>
                  <td>{s.symbol}</td>
                  <td>{s.direction}</td>
                  <td>{s.suggested_action}</td>
                  <td style={muted}>{s.explanation}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}
