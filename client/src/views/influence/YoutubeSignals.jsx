import { useEffect, useState } from 'react'
import { api } from '../../api.js'
import { DirectionBadge } from './InfluenceLayout.jsx'
import { card, muted } from './ui.js'

export default function YoutubeSignals() {
  const [signals, setSignals] = useState([])
  const [error, setError] = useState(null)

  useEffect(() => {
    api.influenceSignals('youtube').then(setSignals).catch((e) => setError(e.message))
  }, [])

  return (
    <section style={card}>
      <h3>YouTube Research Signals</h3>
      <p style={muted}>These are market-intelligence signals only. They are not sent to the live order pipeline.</p>
      {error && <p style={{ color: '#fca5a5' }}>{error}</p>}
      {signals.length === 0 ? <p style={muted}>No signals generated yet.</p> : (
        <table>
          <thead><tr><th>Time</th><th>Asset</th><th>Direction</th><th>Strength</th><th>Action</th><th>Explanation</th></tr></thead>
          <tbody>
            {signals.map((s) => (
              <tr key={s.id}>
                <td>{s.created_at}</td>
                <td>{s.symbol}</td>
                <td><DirectionBadge direction={s.direction} /></td>
                <td>{s.strength_score.toFixed(0)}</td>
                <td>{s.suggested_action}</td>
                <td style={{ ...muted, maxWidth: 460 }}>{s.explanation}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
