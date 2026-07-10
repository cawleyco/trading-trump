import { useEffect, useState } from 'react'
import { api } from '../../api.js'
import { DirectionBadge, PumpRiskBadge } from './InfluenceLayout.jsx'
import { card, muted } from './ui.js'
import { InvestButton } from '../../components/InvestButton.jsx'

export default function YoutubeMentions() {
  const [mentions, setMentions] = useState([])
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(null)

  const refresh = () => api.youtubeMentions().then(setMentions).catch((e) => setError(e.message))
  useEffect(() => { refresh() }, [])

  const classify = async (id) => {
    setBusy(id)
    try {
      await api.classifyYoutubeMention(id)
      refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <section style={card}>
      <h3>Asset Mentions</h3>
      <p style={muted}>Detected transcript mentions with classification, quality, and pump-risk signals.</p>
      {error && <p style={{ color: 'var(--color-bearish)' }}>{error}</p>}
      {mentions.length === 0 ? <p style={muted}>No mentions detected yet.</p> : (
        <table>
          <thead><tr><th>Time</th><th>Creator</th><th>Asset</th><th>Direction</th><th>Type</th><th>Quality</th><th>Pump risk</th><th>Evidence</th><th></th></tr></thead>
          <tbody>
            {mentions.map((m) => (
              <tr key={m.id}>
                <td>{m.event_time}</td>
                <td>{m.channel_title || '—'}</td>
                <td>{m.symbol}</td>
                <td><DirectionBadge direction={m.direction} /></td>
                <td>{m.mention_type || '—'}</td>
                <td>{m.mention_quality_score == null ? '—' : m.mention_quality_score.toFixed(0)}</td>
                <td><PumpRiskBadge score={m.pump_risk_score} /></td>
                <td style={{ ...muted, maxWidth: 360 }}>{m.summary || m.surrounding_text}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <InvestButton
                    ticker={m.symbol}
                    direction={m.direction === 'bearish' ? 'sell' : 'buy'}
                    origin={{ kind: 'influence', surface: 'youtube-mentions' }}
                    style={{ marginRight: 6 }}
                  />
                  <button onClick={() => classify(m.id)} disabled={busy === m.id}>Classify</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
