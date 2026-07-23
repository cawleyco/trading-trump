import { useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'
import { HelpLink } from '../components/intel/components.jsx'
import { InvestButton } from '../components/InvestButton.jsx'

const DEFAULT_DAYS = 90

function todayIso() {
  return new Date().toISOString().slice(0, 10)
}

function addDaysIso(date, days) {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function weekKey(date) {
  const d = new Date(`${date}T00:00:00Z`)
  const day = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() - day + 1)
  return d.toISOString().slice(0, 10)
}

function formatDate(date) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function typeLabel(type) {
  return {
    hearing: 'Hearing',
    'bill-action': 'Bill action',
    'lobbying-deadline': 'LDA deadline',
    earnings: 'Earnings',
    election: 'Election',
  }[type] || type
}

export default function Calendar() {
  const defaultFrom = todayIso()
  const [filters, setFilters] = useState({
    from: defaultFrom,
    to: addDaysIso(defaultFrom, DEFAULT_DAYS),
    sector: '',
  })
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)

  const load = async () => {
    setError(null)
    const data = await api.events({ ...filters, limit: 300 })
    setRows(data)
  }

  useEffect(() => {
    load().catch((e) => setError(e.message)).finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const sectors = useMemo(() => (
    [...new Set(rows.flatMap((r) => r.sectors || []))].sort()
  ), [rows])

  const grouped = useMemo(() => {
    const map = new Map()
    for (const row of rows) {
      const key = weekKey(row.event_date)
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(row)
    }
    return [...map.entries()]
  }, [rows])

  const refreshCollectors = async () => {
    setRefreshing(true)
    setError(null)
    try {
      await api.refreshEvents({ from: filters.from, to: filters.to })
      await load()
    } catch (e) {
      setError(e.message)
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <section style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div>
          <h3 style={{ marginTop: 0 }}>Political Market Calendar <HelpLink slug="calendar" /></h3>
          <p style={{ color: 'var(--color-text-muted)', fontSize: '0.9em', margin: 0 }}>
            Hearings, bill actions, LDA filing deadlines, and elections linked to sectors and recent Congress trades.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => load().catch((e) => setError(e.message))}>Reload</button>
          <button onClick={refreshCollectors} disabled={refreshing}>{refreshing ? 'Refreshing...' : 'Run collectors'}</button>
        </div>
      </div>

      <FilterBar filters={filters} setFilters={setFilters} sectors={sectors} onApply={() => load().catch((e) => setError(e.message))} />
      {error && <p style={{ color: 'var(--color-bearish)' }}>{error}</p>}
      {loading ? <p>Loading events...</p> : <EventGroups groups={grouped} />}
    </section>
  )
}

function FilterBar({ filters, setFilters, sectors, onApply }) {
  const set = (key, value) => setFilters((f) => ({ ...f, [key]: value }))
  return (
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'end', margin: '16px 0' }}>
      <Label label="From">
        <input type="date" value={filters.from} onChange={(e) => set('from', e.target.value)} />
      </Label>
      <Label label="To">
        <input type="date" value={filters.to} onChange={(e) => set('to', e.target.value)} />
      </Label>
      <Label label="Sector">
        <input list="calendar-sectors" value={filters.sector} onChange={(e) => set('sector', e.target.value)} placeholder="Any" />
        <datalist id="calendar-sectors">{sectors.map((s) => <option key={s} value={s} />)}</datalist>
      </Label>
      <button onClick={onApply}>Apply</button>
    </div>
  )
}

function EventGroups({ groups }) {
  if (groups.length === 0) return <p style={{ color: 'var(--color-text-muted)' }}>No calendar events match this range.</p>
  return (
    <div style={{ display: 'grid', gap: 18 }}>
      {groups.map(([week, events]) => (
        <div key={week}>
          <h4 style={{ margin: '0 0 8px', color: 'var(--color-text-muted)' }}>Week of {formatDate(week)}</h4>
          <div style={{ display: 'grid', gap: 10 }}>
            {events.map((event) => <EventCard key={event.id} event={event} />)}
          </div>
        </div>
      ))}
    </div>
  )
}

function EventCard({ event }) {
  return (
    <div style={eventCard}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={badge}>{typeLabel(event.event_type)}</span>
            <strong>{formatDate(event.event_date)}</strong>
          </div>
          <h4 style={{ margin: '8px 0 4px' }}>{event.title}</h4>
          {event.source_url && <a href={event.source_url} target="_blank" rel="noreferrer">Source</a>}
        </div>
      </div>

      <TokenRow label="Sectors" values={event.sectors || []} />
      <TickerRow tickers={event.related_tickers || []} />
      <RecentTrades trades={event.recentTrades || []} />
    </div>
  )
}

function TokenRow({ label, values }) {
  if (!values.length) return null
  return (
    <div style={row}>
      <span style={labelStyle}>{label}</span>
      <span style={tokens}>{values.map((value) => <span key={value} style={chip}>{value}</span>)}</span>
    </div>
  )
}

function TickerRow({ tickers }) {
  if (!tickers.length) return <p style={{ color: 'var(--color-text-muted)', margin: '10px 0 0' }}>No recent Congress-traded tickers matched these sectors.</p>
  return (
    <div style={row}>
      <span style={labelStyle}>Tickers</span>
      <span style={tokens}>
        {tickers.map((ticker) => (
          <span key={ticker} style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
            <a href={`/app/research/congress-trades?ticker=${encodeURIComponent(ticker)}`} style={{ ...chip, color: 'var(--color-accent-blue)', textDecoration: 'none' }}>
              {ticker}
            </a>
            <InvestButton ticker={ticker} origin={{ kind: 'calendar', surface: 'calendar' }} />
          </span>
        ))}
      </span>
    </div>
  )
}

function RecentTrades({ trades }) {
  if (!trades.length) return null
  return (
    <div style={{ marginTop: 10 }}>
      <div style={labelStyle}>Recent matching trades</div>
      <div style={{ display: 'grid', gap: 6, marginTop: 6 }}>
        {trades.map((trade) => (
          <a key={trade.trade_key} href={`/app/research/congress-trades?ticker=${encodeURIComponent(trade.ticker)}`} style={tradeLink}>
            {trade.disclosure_date || '-'} · {trade.politician} · {trade.type} {trade.ticker} {trade.amount_range ? `· ${trade.amount_range}` : ''}
          </a>
        ))}
      </div>
    </div>
  )
}

function Label({ label, children }) {
  return (
    <label style={{ display: 'grid', gap: 4, color: 'var(--color-text-muted)', fontSize: '0.78em' }}>
      {label}
      {children}
    </label>
  )
}

const card = {
  border: '1px solid var(--color-border-subtle)',
  background: 'var(--color-bg-panel)',
  borderRadius: 10,
  padding: 18,
}

const eventCard = {
  border: '1px solid var(--color-border-subtle)',
  background: 'var(--color-bg-subtle)',
  borderRadius: 10,
  padding: 14,
}

const badge = {
  border: '1px solid var(--color-accent-blue)',
  color: 'var(--color-accent-blue)',
  borderRadius: 999,
  padding: '2px 8px',
  fontSize: '0.75em',
}

const row = {
  display: 'grid',
  gridTemplateColumns: '90px 1fr',
  gap: 10,
  alignItems: 'start',
  marginTop: 10,
}

const labelStyle = {
  color: 'var(--color-text-muted)',
  fontSize: '0.78em',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
}

const tokens = {
  display: 'flex',
  gap: 6,
  flexWrap: 'wrap',
}

const chip = {
  border: '1px solid var(--color-border-strong)',
  borderRadius: 999,
  padding: '2px 8px',
  color: 'var(--color-text-secondary)',
  fontSize: '0.8em',
}

const tradeLink = {
  color: 'var(--color-text-secondary)',
  textDecoration: 'none',
  border: '1px solid var(--color-border-subtle)',
  borderRadius: 8,
  padding: '6px 8px',
  background: 'var(--color-bg-panel)',
}
