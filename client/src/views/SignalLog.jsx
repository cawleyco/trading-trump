import { Fragment, useEffect, useState } from 'react'
import { api } from '../api.js'
import { SignalTable } from './Dashboard.jsx'

export default function SignalLog() {
  const [signals, setSignals] = useState([])

  useEffect(() => {
    api.signals(500).then(setSignals).catch(() => {})
  }, [])

  return (
    <section>
      <ReviewQueue />
      <h3>Full Signal & Decision Log</h3>
      <p style={{ color: '#a1a1aa', fontSize: '0.9em' }}>
        Every signal the bot generated, including rejected ones, with the risk manager's reasoning.
      </p>
      <SignalTable signals={signals} />
    </section>
  )
}

function ReviewQueue() {
  const [items, setItems] = useState([])
  const [expanded, setExpanded] = useState(null)

  const refresh = () => api.reviewQueue('pending').then(setItems).catch(() => {})
  useEffect(() => { refresh() }, [])

  const resolve = async (id, status) => {
    try {
      await api.resolveReview(id, status)
    } catch { /* ignore */ }
    refresh()
  }

  if (items.length === 0) return null

  return (
    <section style={card}>
      <h3>Data-quality review queue <span style={{ color: '#eab308' }}>({items.length} pending)</span></h3>
      <p style={{ color: '#a1a1aa', fontSize: '0.85em' }}>
        Low-confidence filings (parse confidence &lt; 0.8) held out of auto-trading until reviewed.
      </p>
      <table>
        <thead>
          <tr>
            <th>Politician</th><th>Ticker</th><th>Dir</th><th>Conf</th><th>Reason</th><th></th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => (
            <Fragment key={it.id}>
              <tr>
                <td>{it.politician}</td>
                <td>{it.ticker}</td>
                <td style={{ color: it.type === 'buy' ? '#86efac' : '#fca5a5' }}>{it.type}</td>
                <td>{it.parse_confidence}</td>
                <td style={{ maxWidth: 300, color: '#a1a1aa' }}>{it.reason}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button onClick={() => setExpanded(expanded === it.id ? null : it.id)} style={{ marginRight: 6 }}>
                    {expanded === it.id ? 'Hide' : 'Filing'}
                  </button>
                  <button onClick={() => resolve(it.id, 'approved')} style={{ marginRight: 6 }}>Approve</button>
                  <button onClick={() => resolve(it.id, 'rejected')}>Reject</button>
                </td>
              </tr>
              {expanded === it.id && (
                <tr>
                  <td colSpan={6}>
                    {it.source_url && (
                      <div style={{ marginBottom: 8 }}>
                        <a href={it.source_url} target="_blank" rel="noreferrer" style={{ color: '#818cf8' }}>
                          {it.source_url}
                        </a>
                      </div>
                    )}
                    <pre style={{ fontSize: '0.75em', background: '#16181d', padding: 10, borderRadius: 6, overflow: 'auto', maxHeight: 240 }}>
                      {JSON.stringify(it.raw, null, 2)}
                    </pre>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </section>
  )
}

const card = {
  background: '#16181d',
  border: '1px solid #26282f',
  borderRadius: 10,
  padding: '16px 20px',
  marginBottom: 24,
}
