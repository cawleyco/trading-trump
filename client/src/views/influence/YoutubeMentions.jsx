import { Fragment, useEffect, useState } from 'react'
import { api } from '../../api.js'
import { DirectionBadge, PumpRiskBadge } from './InfluenceLayout.jsx'
import { card, muted } from './ui.js'
import { InvestButton } from '../../components/InvestButton.jsx'

function MentionCard({ card: c }) {
  const actionColor = c.suggestedAction === 'copy_candidate'
    ? 'var(--color-bullish)'
    : ['avoid', 'fade-candidate'].includes(c.suggestedAction) ? 'var(--color-bearish)' : 'var(--color-text-muted)'
  return (
    <div style={{ padding: '10px 12px', borderLeft: '3px solid var(--color-border)', display: 'grid', gap: 6 }}>
      <div><strong>{c.what}</strong></div>
      {c.whyItMatters?.length > 0 && (
        <div>
          <span style={{ ...muted, fontSize: '0.82em' }}>WHY IT MIGHT MATTER</span>
          <ul style={{ margin: '2px 0 0 18px' }}>{c.whyItMatters.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </div>
      )}
      {c.risks?.length > 0 && (
        <div>
          <span style={{ ...muted, fontSize: '0.82em' }}>RISKS</span>
          <ul style={{ margin: '2px 0 0 18px' }}>{c.risks.map((r, i) => <li key={i}>{r}</li>)}</ul>
        </div>
      )}
      <div>
        <span style={{ ...muted, fontSize: '0.82em' }}>SUGGESTED ACTION </span>
        <strong style={{ color: actionColor, textTransform: 'uppercase' }}>{c.suggestedAction}</strong>
      </div>
    </div>
  )
}

export default function YoutubeMentions() {
  const [mentions, setMentions] = useState([])
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(null)
  const [cards, setCards] = useState({}) // mentionId → card (expanded rows)
  const [bulkStatus, setBulkStatus] = useState(null)
  const [unclassifiedCount, setUnclassifiedCount] = useState(0)

  // The list is capped at the newest rows, so the true unclassified total
  // comes from a dedicated count endpoint rather than the loaded mentions.
  const refresh = () => {
    api.youtubeMentions().then(setMentions).catch((e) => setError(e.message))
    api.youtubeUnclassifiedCount().then((r) => setUnclassifiedCount(r.count)).catch(() => {})
  }
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

  const classifyAll = async () => {
    setBusy('bulk')
    setError(null)
    setBulkStatus(null)
    try {
      const r = await api.classifyAllUnclassifiedYoutubeMentions()
      const parts = [`Classified ${r.classified} of ${r.total}`]
      if (r.failed) parts.push(`${r.failed} failed`)
      if (r.remaining) parts.push(`${r.remaining} still unclassified`)
      setBulkStatus(parts.join(' · ') + (r.errors?.length ? ` — ${r.errors[0]}` : ''))
      refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(null)
    }
  }

  const toggleCard = async (id) => {
    if (cards[id]) {
      setCards(({ [id]: _closed, ...rest }) => rest)
      return
    }
    setBusy(`card-${id}`)
    try {
      const card = await api.youtubeMentionCard(id)
      setCards((prev) => ({ ...prev, [id]: card }))
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <section style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h3 style={{ marginTop: 0 }}>Asset Mentions</h3>
          <p style={muted}>Detected transcript mentions with classification, quality, and pump-risk signals.</p>
        </div>
        <button onClick={classifyAll} disabled={busy === 'bulk' || unclassifiedCount === 0}>
          {busy === 'bulk'
            ? 'Classifying…'
            : unclassifiedCount > 0
              ? `Classify all unclassified (${unclassifiedCount})`
              : 'All classified'}
        </button>
      </div>
      {bulkStatus && <p style={muted}>{bulkStatus}</p>}
      {error && <p style={{ color: 'var(--color-bearish)' }}>{error}</p>}
      {mentions.length === 0 ? <p style={muted}>No mentions detected yet.</p> : (
        <table>
          <thead><tr><th>Time</th><th>Creator</th><th>Asset</th><th>Direction</th><th>Type</th><th>Quality</th><th>Pump risk</th><th>Evidence</th><th></th></tr></thead>
          <tbody>
            {mentions.map((m) => (
              <Fragment key={m.id}>
                <tr>
                  <td>{m.event_time}</td>
                  <td>{m.channel_title || '—'}</td>
                  <td>{m.symbol}</td>
                  <td><DirectionBadge direction={m.direction} /></td>
                  <td>{m.mention_type || '—'}</td>
                  <td>{m.mention_quality_score == null ? '—' : m.mention_quality_score.toFixed(0)}</td>
                  <td><PumpRiskBadge score={m.pump_risk_score} /></td>
                  <td style={{ ...muted, maxWidth: 360 }}>{m.summary || m.surrounding_text}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button onClick={() => toggleCard(m.id)} disabled={busy === `card-${m.id}`} style={{ marginRight: 6 }}>
                      {cards[m.id] ? 'Hide card' : 'Card'}
                    </button>
                    <InvestButton
                      ticker={m.symbol}
                      direction={m.direction === 'bearish' ? 'sell' : 'buy'}
                      rationale={cards[m.id] ? [cards[m.id].what, ...(cards[m.id].whyItMatters || [])].join(' ') : ''}
                      origin={{ kind: 'influence', surface: 'youtube-mentions', mentionId: m.id }}
                      style={{ marginRight: 6 }}
                    />
                    <button onClick={() => classify(m.id)} disabled={busy === m.id}>Classify</button>
                  </td>
                </tr>
                {cards[m.id] && (
                  <tr>
                    <td colSpan={9}>
                      <MentionCard card={cards[m.id]} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
