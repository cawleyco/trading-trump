import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api.js'
import { SectionPanel } from './components.jsx'

const KIND_LABEL = { ticker: 'Ticker', politician: 'Politician', sector: 'Sector', committee: 'Committee' }

/**
 * Small "+ Watch" affordance placed next to a ticker/politician/sector/committee.
 * Optimistically flips to "✓ Watching" on success; onChange lets a parent refresh.
 */
export function WatchButton({ kind, value, note, onChange, size = 'sm' }) {
  const [state, setState] = useState('idle') // idle | saving | done | error
  const add = async (e) => {
    e?.stopPropagation?.()
    if (state === 'saving' || state === 'done') return
    setState('saving')
    try {
      await api.addWatchlist({ kind, value, note })
      setState('done')
      onChange?.()
    } catch {
      setState('error')
    }
  }
  const label = state === 'done' ? '✓ Watching' : state === 'saving' ? '…' : state === 'error' ? 'Retry' : '+ Watch'
  return (
    <button
      type="button"
      onClick={add}
      title={`Watch ${KIND_LABEL[kind] || kind}: ${value}`}
      className={`intel-watch-btn ${state === 'done' ? 'is-done' : ''}`.trim()}
      style={size === 'sm' ? { fontSize: '0.72em', padding: '2px 7px' } : undefined}
    >
      {label}
    </button>
  )
}

/** Dashboard panel: manage watched entities and show recent activity touching them. */
export function WatchlistPanel() {
  const [items, setItems] = useState([])
  const [activity, setActivity] = useState({ trades: [], events: [] })
  const [error, setError] = useState(null)

  const load = useCallback(() => {
    Promise.all([api.watchlist(), api.watchlistActivity(15)])
      .then(([list, act]) => { setItems(list); setActivity(act); setError(null) })
      .catch((e) => setError(e.message))
  }, [])

  useEffect(() => { load() }, [load])

  const remove = async (id) => {
    try {
      await api.removeWatchlist(id)
      load()
    } catch (e) {
      setError(e.message)
    }
  }

  const hasActivity = (activity.trades?.length || 0) + (activity.events?.length || 0) > 0

  return (
    <SectionPanel title="Watchlist" description="Latest archive activity touching your watched tickers, politicians, sectors, and committees.">
      {error && <p style={{ color: 'var(--color-bearish, #f87171)' }}>{error}</p>}
      {items.length === 0 ? (
        <p className="intel-muted">Nothing watched yet. Add tickers, politicians, or sectors from the Intel and Politicians views.</p>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
          {items.map((it) => (
            <span key={it.id} className="intel-chip" style={chip}>
              <small style={{ color: 'var(--color-text-muted)' }}>{KIND_LABEL[it.kind] || it.kind}</small>
              <span>{it.value}</span>
              <button type="button" onClick={() => remove(it.id)} title="Remove" style={removeBtn}>×</button>
            </span>
          ))}
        </div>
      )}

      {items.length > 0 && (
        !hasActivity ? (
          <p className="intel-muted">No recent activity for watched items.</p>
        ) : (
          <div style={{ display: 'grid', gap: 6 }}>
            {activity.trades.map((t) => (
              <a key={t.trade_key} href={`/app/trades?ticker=${encodeURIComponent(t.ticker)}`} style={activityRow}>
                <span style={{ color: 'var(--color-text-muted)', minWidth: 88 }}>{t.disclosure_date || '—'}</span>
                <span>
                  {t.politician} · <strong style={{ color: t.type === 'buy' ? '#4ade80' : '#f87171' }}>{t.type}</strong> {t.ticker}
                  {t.amount_range ? ` · ${t.amount_range}` : ''}
                </span>
              </a>
            ))}
            {activity.events.map((ev) => (
              <div key={`ev-${ev.id}`} style={activityRow}>
                <span style={{ color: 'var(--color-text-muted)', minWidth: 88 }}>{ev.event_date}</span>
                <span>📅 {ev.title}</span>
              </div>
            ))}
          </div>
        )
      )}
    </SectionPanel>
  )
}

const chip = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  border: '1px solid var(--color-border-subtle)',
  borderRadius: 999,
  padding: '3px 8px',
  fontSize: '0.82em',
}

const removeBtn = {
  border: 'none',
  background: 'transparent',
  color: 'var(--color-text-muted)',
  cursor: 'pointer',
  fontSize: '1.1em',
  lineHeight: 1,
  padding: 0,
}

const activityRow = {
  display: 'flex',
  gap: 10,
  fontSize: '0.85em',
  textDecoration: 'none',
  color: 'inherit',
  padding: '3px 0',
}
