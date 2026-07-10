import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { api } from '../api.js'
import { DossierHeader, PageHeader, SectionPanel } from '../components/intel/components.jsx'
import { WatchButton } from '../components/intel/Watchlist.jsx'

export default function Politicians() {
  const [rows, setRows] = useState([])
  const [profile, setProfile] = useState(null)
  const [graph, setGraph] = useState(null)
  const [selected, setSelected] = useState(null)
  const [query, setQuery] = useState('')
  const [sortKey, setSortKey] = useState('edge_score')
  const [asc, setAsc] = useState(false)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)

  const loadRows = useCallback(async () => {
    setError(null)
    const data = await api.politicianStats()
    setRows(data)
    if (data.length) setSelected((current) => current || data[0].politician)
  }, [])

  useEffect(() => {
    loadRows().catch((e) => setError(e.message)).finally(() => setLoading(false))
  }, [loadRows])

  useEffect(() => {
    if (!selected) return
    setProfile(null)
    setGraph(null)
    api.politicianProfile(selected).then(setProfile).catch((e) => setError(e.message))
    api.politicianGraph(selected).then(setGraph).catch(() => setGraph(null))
  }, [selected])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const base = needle ? rows.filter((r) => r.politician.toLowerCase().includes(needle)) : rows
    return [...base].sort((a, b) => {
      const av = a[sortKey]
      const bv = b[sortKey]
      const aNull = av == null
      const bNull = bv == null
      if (aNull || bNull) return aNull === bNull ? 0 : aNull ? 1 : -1
      const d = typeof av === 'string' ? av.localeCompare(bv) : av - bv
      return asc ? d : -d
    })
  }, [rows, query, sortKey, asc])

  const refreshStats = async () => {
    setRefreshing(true)
    setError(null)
    try {
      await api.refreshPoliticianStats()
      await loadRows()
    } catch (e) {
      setError(e.message)
    } finally {
      setRefreshing(false)
    }
  }

  const refreshGraph = async () => {
    setRefreshing(true)
    setError(null)
    try {
      await api.refreshGraph()
      if (selected) setGraph(await api.politicianGraph(selected))
    } catch (e) {
      setError(e.message)
    } finally {
      setRefreshing(false)
    }
  }

  const sortBy = (key, defaultAsc = false) => {
    if (sortKey === key) setAsc(!asc)
    else { setSortKey(key); setAsc(defaultAsc) }
  }

  if (loading) return <p className="intel-muted">Loading politician dossiers...</p>

  return (
    <div>
      <PageHeader
        eyebrow="Influence / Politicians"
        helpSlug="politicians"
        title="Politician Dossiers"
        description="Historical disclosure-entry returns, disclosure lag, concentration, and edge scoring for measurable public trades."
        meta="Neutral coverage · disclosure lag reduces actionability"
        actions={(
          <>
            <button onClick={refreshStats} disabled={refreshing}>
              {refreshing ? 'Refreshing...' : 'Refresh stats'}
            </button>
            <button onClick={refreshGraph} disabled={refreshing}>
              {refreshing ? 'Refreshing...' : 'Refresh graph'}
            </button>
          </>
        )}
      />
      <SectionPanel>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div>
            <h3 style={{ marginTop: 0 }}>Politician Alpha Profiles</h3>
            <p style={{ color: 'var(--color-text-muted)', fontSize: '0.9em', margin: 0 }}>
              Historical disclosure-entry returns, disclosure lag, concentration, and an edge score for members with enough measurable buys.
            </p>
          </div>
        </div>
        {error && <p style={{ color: '#fca5a5' }}>{error}</p>}
        {rows.length === 0 ? (
          <p className="intel-muted">No stats yet. Run a refresh after the congress archive has trades.</p>
        ) : (
          <>
            <div style={{ margin: '16px 0 10px' }}>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search politician"
                style={{ minWidth: 260 }}
              />
            </div>
            <StatsTable
              rows={filtered}
              selected={selected}
              onSelect={setSelected}
              sortKey={sortKey}
              asc={asc}
              sortBy={sortBy}
            />
          </>
        )}
      </SectionPanel>

      {profile && <ProfileTearSheet profile={profile} graph={graph} />}
    </div>
  )
}

function StatsTable({ rows, selected, onSelect, sortKey, asc, sortBy }) {
  const th = (key, label, defaultAsc = false) => (
    <th onClick={() => sortBy(key, defaultAsc)} style={{ cursor: 'pointer', userSelect: 'none' }}>
      {label}{sortKey === key ? (asc ? ' ▲' : ' ▼') : ''}
    </th>
  )
  return (
    <table>
      <thead>
        <tr>
          {th('politician', 'Politician', true)}
          {th('edge_score', 'Edge')}
          {th('trade_count', 'Trades')}
          {th('win_rate_30d', '30d win')}
          {th('avg_return_90d', '90d avg')}
          {th('median_disclosure_lag', 'Median lag')}
          {th('concentration_hhi', 'HHI')}
          <th></th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr
            key={r.politician}
            onClick={() => onSelect(r.politician)}
            style={{
              cursor: 'pointer',
              background: r.politician === selected ? 'rgba(245, 177, 76, 0.09)' : undefined,
            }}
          >
            <td>{r.politician}</td>
            <td>{r.edge_score == null ? <span style={{ color: '#a1a1aa' }}>unknown</span> : r.edge_score}</td>
            <td>{r.trade_count ?? 0}</td>
            <td>{pct(r.win_rate_30d)}</td>
            <td style={{ color: colorFor(r.avg_return_90d) }}>{pct(r.avg_return_90d, true)}</td>
            <td>{r.median_disclosure_lag == null ? '—' : `${r.median_disclosure_lag}d`}</td>
            <td>{r.concentration_hhi == null ? '—' : r.concentration_hhi}</td>
            <td><WatchButton kind="politician" value={r.politician} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function ProfileTearSheet({ profile, graph }) {
  const horizonData = [
    { horizon: '7d', returnPct: profile.avg_return_7d },
    { horizon: '30d', returnPct: profile.avg_return_30d },
    { horizon: '90d', returnPct: profile.avg_return_90d },
    { horizon: '180d', returnPct: profile.avg_return_180d },
  ].filter((r) => r.returnPct != null)
  const sectorData = Object.entries(profile.sector_returns || {})
    .map(([sector, v]) => ({ sector, avgReturn30d: v.avgReturn30d, trades: v.trades }))
    .sort((a, b) => b.trades - a.trades)
  const lagData = [
    { label: 'Median disclosure lag', days: profile.median_disclosure_lag ?? 0 },
  ]

  return (
    <section style={{ marginTop: 24 }}>
      <DossierHeader
        entityType="politician"
        name={profile.politician}
        subtitle={`As of ${profile.as_of}. Best hold window: ${profile.best_hold_window || 'unknown'}.`}
        badges={[
          { label: profile.edge_score == null ? 'INSUFFICIENT DATA' : 'EDGE SCORED', tone: profile.edge_score == null ? 'neutral' : 'info' },
          { label: 'NEUTRAL COVERAGE', tone: 'neutral' },
        ]}
        stats={[
          { label: 'Edge score', value: profile.edge_score == null ? 'Unknown' : profile.edge_score },
          { label: '30D win rate', value: pct(profile.win_rate_30d) },
          { label: '90D avg return', value: pct(profile.avg_return_90d, true) },
          { label: 'Measured buys', value: profile.stats?.measured_buys ?? 0 },
        ]}
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 18, marginTop: 18 }}>
        <ChartCard title="Returns by horizon">
          <BarChart data={horizonData}>
            <CartesianGrid stroke="#26282f" />
            <XAxis dataKey="horizon" stroke="#a1a1aa" />
            <YAxis stroke="#a1a1aa" tickFormatter={(v) => `${v}%`} />
            <Tooltip contentStyle={tooltipStyle} formatter={(v) => [`${v}%`, 'Average return']} />
            <Bar dataKey="returnPct" fill="#6366f1" />
          </BarChart>
        </ChartCard>

        <ChartCard title="Sector 30d returns">
          <BarChart data={sectorData}>
            <CartesianGrid stroke="#26282f" />
            <XAxis dataKey="sector" stroke="#a1a1aa" fontSize={10} interval={0} angle={-20} textAnchor="end" height={54} />
            <YAxis stroke="#a1a1aa" tickFormatter={(v) => `${v}%`} />
            <Tooltip contentStyle={tooltipStyle} formatter={(v, name) => [name === 'avgReturn30d' ? `${v}%` : v, name === 'avgReturn30d' ? '30d return' : 'Trades']} />
            <Bar dataKey="avgReturn30d" fill="#22c55e" />
          </BarChart>
        </ChartCard>

        <ChartCard title="Disclosure lag">
          <BarChart data={lagData}>
            <CartesianGrid stroke="#26282f" />
            <XAxis dataKey="label" stroke="#a1a1aa" fontSize={11} />
            <YAxis stroke="#a1a1aa" tickFormatter={(v) => `${v}d`} />
            <Tooltip contentStyle={tooltipStyle} formatter={(v) => [`${v} days`, 'Lag']} />
            <Bar dataKey="days" fill="#eab308" />
          </BarChart>
        </ChartCard>
      </div>

      <RecentTrades trades={profile.recentTrades || []} />
      <PoliticianConnections graph={graph} />
    </section>
  )
}

function PoliticianConnections({ graph }) {
  if (!graph) {
    return (
      <details style={{ marginTop: 18 }}>
        <summary style={{ cursor: 'pointer' }}>Political connections</summary>
        <p style={{ color: '#a1a1aa' }}>No graph context yet. Run graph refresh to link committees and bills.</p>
      </details>
    )
  }
  return (
    <details style={{ marginTop: 18 }} open>
      <summary style={{ cursor: 'pointer' }}>Political connections</summary>
      <div style={{ display: 'grid', gap: 12, marginTop: 10 }}>
        <MiniList
          title="Committees"
          rows={graph.committees || []}
          empty="No committee memberships linked."
          render={(c) => `${c.name}${c.role ? ` (${c.role})` : ''}${c.sectors?.length ? ` · ${c.sectors.join(', ')}` : ''}`}
        />
        <MiniList
          title="Recent related bills"
          rows={graph.bills || []}
          empty="No recent related bills."
          render={(b) => `${b.latest_action_date || 'unknown date'} · ${b.title || b.bill_id}`}
          link={(b) => b.source_url}
        />
      </div>
    </details>
  )
}

function MiniList({ title, rows, empty, render, link }) {
  const visible = rows.slice(0, 10)
  return (
    <div>
      <h4 style={{ margin: '0 0 6px' }}>{title}</h4>
      {visible.length === 0 ? (
        <p style={{ color: '#a1a1aa', margin: 0 }}>{empty}</p>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 4 }}>
          {visible.map((row, i) => {
            const href = link?.(row)
            const text = render(row)
            return <li key={row.committee_id || row.bill_id || i}>{href ? <a href={href} target="_blank" rel="noreferrer">{text}</a> : text}</li>
          })}
        </ul>
      )}
    </div>
  )
}

function ChartCard({ title, children }) {
  return (
    <div style={{ border: '1px solid #26282f', borderRadius: 8, padding: 12, minHeight: 260 }}>
      <h4 style={{ margin: '0 0 8px' }}>{title}</h4>
      <div style={{ height: 210 }}>
        <ResponsiveContainer>{children}</ResponsiveContainer>
      </div>
    </div>
  )
}

function RecentTrades({ trades }) {
  return (
    <details style={{ marginTop: 18 }} open>
      <summary style={{ cursor: 'pointer' }}>Recent archived trades ({trades.length})</summary>
      {trades.length === 0 ? (
        <p style={{ color: '#a1a1aa' }}>No archived trades.</p>
      ) : (
        <table style={{ marginTop: 10 }}>
          <thead>
            <tr><th>Disclosure</th><th>Ticker</th><th>Dir</th><th>Amount</th><th>Owner</th><th>Quality</th></tr>
          </thead>
          <tbody>
            {trades.map((t) => (
              <tr key={t.trade_key}>
                <td>{t.disclosure_date || '—'}</td>
                <td>{t.ticker}</td>
                <td style={{ color: t.type === 'buy' ? '#86efac' : '#fca5a5' }}>{t.type}</td>
                <td>{t.amount_range || (t.amount_mid ? `$${Number(t.amount_mid).toLocaleString()}` : '—')}</td>
                <td>{t.owner || '—'}</td>
                <td>{t.is_option ? 'option' : t.parse_confidence < 0.8 ? 'review' : 'ok'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </details>
  )
}

function pct(value, signed = false) {
  if (value == null) return '—'
  return `${signed && value > 0 ? '+' : ''}${value}%`
}

function colorFor(value) {
  if (value == null) return '#a1a1aa'
  return value < 0 ? '#fca5a5' : '#86efac'
}

const tooltipStyle = { background: '#1f2229', border: '1px solid #3f3f46' }
