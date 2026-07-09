import { useEffect, useState } from 'react'
import { api } from '../api.js'
import {
  PageHeader,
  SectionPanel,
  IntelligenceTable,
  EmptyState,
  LoadingSkeleton,
} from '../components/intel/components.jsx'
import { WatchButton } from '../components/intel/Watchlist.jsx'

const TABS = [
  { key: 'most-active', label: 'Most active' },
  { key: 'sector-heatmap', label: 'Sector heatmap' },
  { key: 'committee-heatmap', label: 'Committee heatmap' },
  { key: 'exposed-stocks', label: 'Exposed stocks' },
  { key: 'disclosure-quality', label: 'Disclosure quality' },
  { key: 'copy-performance', label: 'Copy performance' },
]

const LOADERS = {
  'most-active': () => api.aggMostActive(30, 25),
  'sector-heatmap': () => api.aggSectorHeatmap(90),
  'committee-heatmap': () => api.aggCommitteeHeatmap(180),
  'exposed-stocks': () => api.aggExposedStocks(180, 25),
  'disclosure-quality': () => api.aggDisclosureQuality(3),
  'copy-performance': () => api.aggCopyPerformance(10),
}

export default function Intel() {
  const [tab, setTab] = useState('most-active')
  const [state, setState] = useState({ loading: true, error: null, data: null })

  useEffect(() => {
    let cancelled = false
    setState({ loading: true, error: null, data: null })
    LOADERS[tab]()
      .then((data) => { if (!cancelled) setState({ loading: false, error: null, data }) })
      .catch((e) => { if (!cancelled) setState({ loading: false, error: e.message, data: null }) })
    return () => { cancelled = true }
  }, [tab])

  return (
    <>
      <PageHeader
        eyebrow="Intelligence dashboards"
        title="Intel"
        description="Cross-source aggregates over the Congress-trade archive: activity, sector and committee heatmaps, conflict-risk exposure, disclosure quality, and copy performance."
        meta="Read-only · aggregates recompute on each load"
      />
      <div className="intel-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            className={`intel-tab ${tab === t.key ? 'is-active' : ''}`.trim()}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <SectionPanel>
        {state.loading ? (
          <LoadingSkeleton />
        ) : state.error ? (
          <EmptyState title="Could not load aggregate" body={state.error} />
        ) : (
          <TabBody tab={tab} data={state.data} />
        )}
      </SectionPanel>
    </>
  )
}

function TabBody({ tab, data }) {
  if (tab === 'most-active') return <MostActive rows={data} />
  if (tab === 'sector-heatmap') return <Heatmap matrix={data} valueKey="net" rowLabel="Sector" rowKind="sector" formatCol={weekLabel} legend="Net buys − sells" />
  if (tab === 'committee-heatmap') return <Heatmap matrix={data} valueKey="trades" rowLabel="Committee" formatCol={(c) => c} legend="Trade count" diverging={false} />
  if (tab === 'exposed-stocks') return <ExposedStocks rows={data} />
  if (tab === 'disclosure-quality') return <DisclosureQuality rows={data} />
  if (tab === 'copy-performance') return <CopyPerformance data={data} />
  return null
}

function tickerLink(ticker) {
  return <a href={`/app/trades?ticker=${encodeURIComponent(ticker)}`}>{ticker}</a>
}

function num(v, digits = 0) {
  return v == null ? '-' : Number(v).toFixed(digits)
}

function MostActive({ rows }) {
  if (!rows?.length) return <EmptyState title="No trades in window" body="No Congress trades disclosed in the last 30 days." />
  return (
    <IntelligenceTable
      rowKey={(r) => r.ticker}
      columns={[
        { key: 'ticker', label: 'Ticker', mono: true, render: (r) => tickerLink(r.ticker) },
        { key: 'companyName', label: 'Company', render: (r) => r.companyName || '-' },
        { key: 'sector', label: 'Sector', render: (r) => r.sector || '-' },
        { key: 'buyCount', label: 'Buys', numeric: true },
        { key: 'sellCount', label: 'Sells', numeric: true },
        { key: 'netSentiment', label: 'Net', numeric: true, render: (r) => <span style={{ color: netColor(r.netSentiment) }}>{r.netSentiment > 0 ? `+${r.netSentiment}` : r.netSentiment}</span> },
        { key: 'politicianCount', label: 'Politicians', numeric: true },
        { key: 'avgScore', label: 'Avg score', numeric: true, render: (r) => (r.avgScore == null ? '-' : num(r.avgScore, 1)) },
        { key: 'watch', label: '', render: (r) => <WatchButton kind="ticker" value={r.ticker} /> },
      ]}
      rows={rows}
    />
  )
}

function ExposedStocks({ rows }) {
  if (!rows?.length) return <EmptyState title="No exposure data" body="No trades, lobbying, or contracts in the last 180 days." />
  return (
    <IntelligenceTable
      rowKey={(r) => r.ticker}
      columns={[
        { key: 'riskIndex', label: 'Risk', numeric: true, render: (r) => <RiskCell value={r.riskIndex} /> },
        { key: 'ticker', label: 'Ticker', mono: true, render: (r) => tickerLink(r.ticker) },
        { key: 'companyName', label: 'Company', render: (r) => r.companyName || '-' },
        { key: 'sector', label: 'Sector', render: (r) => r.sector || '-' },
        { key: 'tradeCount', label: 'Trades', numeric: true },
        { key: 'politicianCount', label: 'Politicians', numeric: true },
        { key: 'lobbyingCount', label: 'Lobbying', numeric: true },
        { key: 'contractCount', label: 'Contracts', numeric: true },
        { key: 'avgScore', label: 'Avg score', numeric: true, render: (r) => (r.avgScore == null ? '-' : num(r.avgScore, 1)) },
        { key: 'watch', label: '', render: (r) => <WatchButton kind="ticker" value={r.ticker} /> },
      ]}
      rows={rows}
    />
  )
}

function DisclosureQuality({ rows }) {
  if (!rows?.length) return <EmptyState title="No disclosure data" body="Not enough dated trades to rank filing speed." />
  return (
    <IntelligenceTable
      rowKey={(r) => r.politician}
      columns={[
        { key: 'politician', label: 'Politician' },
        { key: 'tradeCount', label: 'Trades', numeric: true },
        { key: 'medianLagDays', label: 'Median lag (d)', numeric: true, render: (r) => num(r.medianLagDays, 1) },
        { key: 'pctWithin15', label: '≤15d %', numeric: true, render: (r) => num(r.pctWithin15, 1) },
        { key: 'pctWithin30', label: '≤30d %', numeric: true, render: (r) => num(r.pctWithin30, 1) },
        { key: 'pctWithin45', label: '≤45d %', numeric: true, render: (r) => num(r.pctWithin45, 1) },
      ]}
      rows={rows}
    />
  )
}

function CopyPerformance({ data }) {
  const backtests = data?.backtests || []
  const matches = data?.strategyMatches || []
  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <div>
        <h3 style={{ margin: '0 0 8px' }}>Disclosure-basis backtests vs SPY</h3>
        {backtests.length === 0 ? (
          <p className="intel-muted">No disclosure-basis Congress backtests saved yet. Run one from the Backtesting view.</p>
        ) : (
          <IntelligenceTable
            rowKey={(r) => r.id}
            columns={[
              { key: 'politician', label: 'Politician' },
              { key: 'range', label: 'Window', render: (r) => `${r.startDate || '?'} → ${r.endDate || '?'}` },
              { key: 'exitRule', label: 'Exit', render: (r) => r.exitRule || '-' },
              { key: 'totalTrades', label: 'Trades', numeric: true },
              { key: 'winRate', label: 'Win %', numeric: true, render: (r) => num(r.winRate, 1) },
              { key: 'returnPct', label: 'Return %', numeric: true, render: (r) => num(r.returnPct, 2) },
              { key: 'spyReturnPct', label: 'SPY %', numeric: true, render: (r) => num(r.spyReturnPct, 2) },
              { key: 'alphaPct', label: 'Alpha %', numeric: true, render: (r) => (r.alphaPct == null ? '-' : <span style={{ color: netColor(r.alphaPct) }}>{num(r.alphaPct, 2)}</span>) },
            ]}
            rows={backtests}
          />
        )}
      </div>
      <div>
        <h3 style={{ margin: '0 0 8px' }}>Live strategy matches</h3>
        {matches.length === 0 ? (
          <p className="intel-muted">No strategy evaluations recorded yet.</p>
        ) : (
          <IntelligenceTable
            rowKey={(r) => r.strategy}
            columns={[
              { key: 'strategy', label: 'Strategy' },
              { key: 'total', label: 'Evaluated', numeric: true },
              { key: 'matched', label: 'Matched', numeric: true },
              { key: 'traded', label: 'Signalled', numeric: true },
            ]}
            rows={matches}
          />
        )}
      </div>
    </div>
  )
}

// --- heatmap ---

function Heatmap({ matrix, valueKey, rowLabel, rowKind, formatCol, legend, diverging = true }) {
  if (!matrix?.rows?.length || !matrix?.cols?.length) {
    return <EmptyState title="No heatmap data" body="Not enough classified trades to build this grid." />
  }
  const values = []
  for (const r of matrix.rows) {
    for (const c of matrix.cols) {
      const cell = matrix.cells[r]?.[c]
      if (cell) values.push(cell[valueKey])
    }
  }
  const maxAbs = Math.max(1, ...values.map((v) => Math.abs(v)))
  return (
    <div>
      <div className="intel-muted" style={{ marginBottom: 10, fontSize: '0.82em' }}>{legend}</div>
      <div className="intel-table-wrap">
        <table className="intel-table">
          <thead>
            <tr>
              <th>{rowLabel}</th>
              {matrix.cols.map((c) => <th key={c} className="is-numeric">{formatCol(c)}</th>)}
            </tr>
          </thead>
          <tbody>
            {matrix.rows.map((r) => (
              <tr key={r}>
                <td>
                  {rowKind ? (
                    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                      {r}
                      <WatchButton kind={rowKind} value={r} />
                    </span>
                  ) : r}
                </td>
                {matrix.cols.map((c) => {
                  const cell = matrix.cells[r]?.[c]
                  const v = cell ? cell[valueKey] : null
                  return (
                    <td key={c} className="is-numeric" style={{ background: cellColor(v, maxAbs, diverging), textAlign: 'center' }}>
                      {v == null || v === 0 ? '' : v}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function cellColor(v, maxAbs, diverging) {
  if (v == null || v === 0) return 'transparent'
  const t = Math.min(1, Math.abs(v) / maxAbs)
  const alpha = 0.15 + 0.55 * t
  if (!diverging) return `rgba(99, 102, 241, ${alpha})` // indigo intensity
  return v > 0 ? `rgba(34, 197, 94, ${alpha})` : `rgba(239, 68, 68, ${alpha})`
}

function netColor(v) {
  if (v > 0) return '#4ade80'
  if (v < 0) return '#f87171'
  return 'inherit'
}

function RiskCell({ value }) {
  const tone = value >= 70 ? '#f87171' : value >= 40 ? '#fbbf24' : '#4ade80'
  return <strong style={{ color: tone }}>{value}</strong>
}

function weekLabel(iso) {
  const d = new Date(`${iso}T00:00:00Z`)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
