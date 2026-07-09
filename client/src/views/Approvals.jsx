import { useEffect, useState } from 'react'
import { api } from '../api.js'

export default function Approvals() {
  const [status, setStatus] = useState('pending')
  const [approvals, setApprovals] = useState([])
  const [error, setError] = useState(null)
  const [busyId, setBusyId] = useState(null)

  const load = () => {
    setError(null)
    api.approvals(status).then(setApprovals).catch((e) => setError(e.message))
  }

  useEffect(load, [status])

  const resolve = async (approval, action) => {
    setBusyId(approval.id)
    setError(null)
    try {
      if (action === 'approve') await api.approveStrategy(approval.id)
      else await api.rejectStrategy(approval.id)
      load()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div>
      <section style={card}>
        <h3>Manual Approvals</h3>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label>Status</label>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
            <option value="expired">Expired</option>
          </select>
          <button onClick={load}>Refresh</button>
        </div>
        {error && <p style={{ color: '#fca5a5' }}>{error}</p>}
      </section>

      {approvals.length === 0 && (
        <section style={card}>
          <p style={{ color: '#a1a1aa' }}>No {status} approvals.</p>
        </section>
      )}

      {approvals.map((approval) => (
        <section key={approval.id} style={card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
            <div>
              <h3 style={{ marginTop: 0 }}>{approval.ticker} {approval.type}</h3>
              <p style={{ margin: 0 }}>
                {approval.strategy_name} matched {approval.politician} ({approval.trade_key})
              </p>
              <p style={{ color: '#a1a1aa', marginTop: 6 }}>
                Proposed: {approval.proposed.direction} ${approval.proposed.notionalUsd} of {approval.proposed.ticker}
                {approval.proposed.fund ? ` in ${approval.proposed.fund}` : ''}. Expires {approval.expires_at}.
              </p>
            </div>
            {approval.status === 'pending' && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <button onClick={() => resolve(approval, 'approve')} disabled={busyId === approval.id} style={{ borderColor: '#22c55e' }}>
                  {busyId === approval.id ? 'Working...' : 'Approve'}
                </button>
                <button onClick={() => resolve(approval, 'reject')} disabled={busyId === approval.id} style={{ borderColor: '#ef4444' }}>
                  Reject
                </button>
              </div>
            )}
          </div>
          <Thesis thesis={approval.thesis} />
        </section>
      ))}
    </div>
  )
}

function Thesis({ thesis }) {
  const cardData = thesis?.card
  if (!cardData) return <p style={{ color: '#a1a1aa' }}>No thesis card available yet.</p>
  return (
    <div style={{ borderTop: '1px solid #27272a', marginTop: 12, paddingTop: 12 }}>
      <strong>Thesis</strong>
      <p>{cardData.what}</p>
      {cardData.whyItMatters?.length > 0 && (
        <ul>
          {cardData.whyItMatters.map((item, i) => <li key={i}>{item}</li>)}
        </ul>
      )}
      {cardData.sinceThen && <p>{cardData.sinceThen}</p>}
      {cardData.risks?.length > 0 && (
        <p style={{ color: '#fbbf24' }}>Risks: {cardData.risks.join(' ')}</p>
      )}
      <p style={{ color: '#a1a1aa' }}>
        Score {cardData.signal?.copyScore ?? 'n/a'}, confidence {cardData.signal?.confidence ?? 'n/a'},
        recommendation {cardData.signal?.recommendation ?? 'n/a'}.
      </p>
    </div>
  )
}

const card = { background: '#18181b', border: '1px solid #27272a', borderRadius: 10, padding: 16, marginBottom: 16 }
