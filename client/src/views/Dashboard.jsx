import { useEffect, useState } from 'react'
import {
  LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer, ReferenceLine, Legend,
} from 'recharts'
import { api } from '../api.js'
import {
  MetricCard,
  PageHeader,
  SectionPanel,
  SignalCard,
} from '../components/intel/components.jsx'
import { normalizeSignal } from '../components/intel/signalUtils.js'
import { WatchlistPanel } from '../components/intel/Watchlist.jsx'

const LINE_COLORS = ['#6366f1', '#22c55e', '#eab308', '#ec4899', '#06b6d4', '#f97316']

export default function Dashboard() {
  const [status, setStatus] = useState(null)
  const [signals, setSignals] = useState([])
  const [attribution, setAttribution] = useState(null)
  const [filingSpeed, setFilingSpeed] = useState([])
  const [selectedFund, setSelectedFund] = useState(null)
  const [testTicker, setTestTicker] = useState('AAPL')
  const [testResult, setTestResult] = useState(null)

  const refresh = () => {
    api.status().then(setStatus).catch(() => {})
    api.signals(15).then(setSignals).catch(() => {})
    api.attribution().then(setAttribution).catch(() => {})
    api.filingSpeed().then(setFilingSpeed).catch(() => {})
  }

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 15000)
    return () => clearInterval(t)
  }, [])

  if (!status) return <p className="intel-muted">Loading intelligence terminal...</p>

  const funds = status.funds ?? []
  const fund = funds.find((f) => f.name === selectedFund) || funds[0]
  if (!fund) return <p className="intel-muted">No funds reported by the server yet — check funds.json and the startup log.</p>

  const fireTestSignal = async () => {
    setTestResult(null)
    try {
      setTestResult(await api.testSignal({ ticker: testTicker, direction: 'buy', fund: fund.name }))
    } catch (e) {
      setTestResult({ error: e.message })
    }
    refresh()
  }

  return (
    <div>
      <PageHeader
        eyebrow="Overview"
        title="Public Influence Intelligence Terminal"
        description="Track public signals, inspect the evidence, and separate copyable edge from noisy attention."
        meta={`Mode: ${status.tradingMode ?? 'unknown'} · ${funds.length} fund${funds.length === 1 ? '' : 's'} monitored · Signal detected, edge not guaranteed`}
        actions={(
          <>
            <button onClick={refresh}>Refresh</button>
            <button onClick={() => window.history.pushState({}, '', '/app/signals') || window.dispatchEvent(new PopStateEvent('popstate'))}>Explore signals</button>
          </>
        )}
      />

      {funds.length > 1 && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center' }}>
          <span style={{ color: 'var(--color-text-muted)', fontSize: '0.85em' }}>Fund:</span>
          {funds.map((f) => (
            <button
              key={f.name}
              onClick={() => setSelectedFund(f.name)}
              style={f.name === fund.name ? { borderColor: 'var(--color-accent-primary)', background: 'rgba(245, 177, 76, 0.09)' } : {}}
            >
              {f.name}
            </button>
          ))}
        </div>
      )}

      <div className="intel-grid" style={{ marginBottom: 16 }}>
        <MetricCard label="Open positions" value={(fund.positions ?? []).length} helper={fund.name} tone="info" />
        <MetricCard label="Recent signals" value={signals.length} helper="Latest normalized feed sample" />
        <MetricCard label="Data sources" value={(fund.sources ?? []).length} helper={(fund.sources ?? []).join(' + ')} />
        <MetricCard
          label="Account mode"
          value={fund.paper ? 'PAPER' : (status.tradingMode ?? 'unknown').toUpperCase()}
          helper={fund.halted ? 'Manual review active' : 'Risk checks online'}
          tone={fund.halted ? 'bad' : 'warning'}
        />
      </div>

      <div className="intel-dashboard-grid">
        <div>
          <SectionPanel title={`Top Signal Feed - ${fund.name}`} description="Suggested actions are evidence prompts, not guaranteed trades.">
            {signals.length === 0 ? (
              <p className="intel-muted">No signals yet. Edge not confirmed.</p>
            ) : (
              <div className="intel-signal-list">
                {signals.slice(0, 5).map((signal) => {
                  const normalized = normalizeSignal(signal)
                  return <SignalCard key={`${signal.id}-${signal.fund || ''}`} {...normalized} />
                })}
              </div>
            )}
          </SectionPanel>

          <AttributionChart attribution={attribution} />
          <FilingSpeedTable rows={filingSpeed} />
        </div>

        <div>
          <WatchlistPanel />

          <SectionPanel title="Risk Warnings" description="Risk is first-class. Avoid and review states stay visible.">
            <div className="intel-signal-list">
              {signals.filter((s) => s.approved === false || s.order_status === 'rejected').slice(0, 4).map((signal) => {
                const normalized = normalizeSignal(signal)
                return <SignalCard key={`risk-${signal.id}-${signal.fund || ''}`} {...normalized} action="avoid" riskScore={82} />
              })}
              {signals.filter((s) => s.approved === false || s.order_status === 'rejected').length === 0 && (
                <p className="intel-muted">No elevated avoid warnings in the current sample.</p>
              )}
            </div>
          </SectionPanel>

          <SectionPanel title="Open Positions" description={`Current exposure for ${fund.name}.`}>
          {fund.positions.length === 0 ? (
            <p className="intel-muted">No open positions</p>
          ) : (
            <table>
              <thead>
                <tr><th>Symbol</th><th>Qty</th><th>Value</th><th>Unrealized P&L</th></tr>
              </thead>
              <tbody>
                {fund.positions.map((p) => (
                  <tr key={p.symbol}>
                    <td style={{ fontFamily: 'var(--font-mono)' }}>{p.symbol}</td>
                    <td>{p.qty}</td>
                    <td>${p.marketValue.toFixed(2)}</td>
                    <td style={{ color: p.unrealizedPl < 0 ? 'var(--color-bearish)' : 'var(--color-bullish)', fontFamily: 'var(--font-mono)' }}>
                      {p.unrealizedPl >= 0 ? '+' : ''}{p.unrealizedPl.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          </SectionPanel>

          <SectionPanel title="Risk Limits" description={`Configured guardrails for ${fund.name}.`}>
          <table>
            <tbody>
              <tr><td>Max per trade</td><td>${fund.risk.maxTradeNotionalUsd} / {fund.risk.maxTradePctEquity}% equity</td></tr>
              <tr><td>Max open positions</td><td>{fund.risk.maxOpenPositions}</td></tr>
              <tr><td>Max total exposure</td><td>${fund.risk.maxTotalExposureUsd}</td></tr>
              <tr><td>Daily loss limit</td><td>${fund.risk.maxDailyLossUsd} / {fund.risk.maxDailyLossPct}%</td></tr>
              <tr><td>Sources</td><td>{fund.sources.join(', ')}</td></tr>
              <tr><td>Sentiment threshold</td><td>{fund.sentimentConfidenceThreshold}</td></tr>
              <tr><td>Auto-exit</td><td>{fund.autoExit
                ? `SL ${fund.autoExit.stopLossPct ?? '—'}% / TP ${fund.autoExit.takeProfitPct ?? '—'}% / max ${fund.autoExit.maxHoldDays ?? '—'}d`
                : 'off'}</td></tr>
              <tr><td>Account</td><td>{fund.paper ? 'paper' : 'LIVE'} ({status.tradingMode})</td></tr>
            </tbody>
          </table>
          </SectionPanel>

          <SectionPanel title="Pipeline Test" description={`Fire a manual signal at fund "${fund.name}" through the risk pipeline.`}>
          <div style={{ display: 'flex', gap: 8 }}>
            <input value={testTicker} onChange={(e) => setTestTicker(e.target.value.toUpperCase())} style={{ width: 90 }} />
            <button onClick={fireTestSignal}>Send test signal</button>
          </div>
          {testResult && (
            <pre style={{ fontSize: '0.75em', background: '#16181d', padding: 10, borderRadius: 6, overflow: 'auto' }}>
              {JSON.stringify(testResult, null, 2)}
            </pre>
          )}
          </SectionPanel>
        </div>
      </div>
    </div>
  )
}

function FilingSpeedTable({ rows }) {
  const [sortKey, setSortKey] = useState('medianLagDays')
  const [asc, setAsc] = useState(true)
  if (!rows || rows.length === 0) return null

  const sorted = [...rows].sort((a, b) => {
    const d = a[sortKey] < b[sortKey] ? -1 : a[sortKey] > b[sortKey] ? 1 : 0
    return asc ? d : -d
  })
  const sortBy = (key) => {
    if (key === sortKey) setAsc(!asc)
    else { setSortKey(key); setAsc(key === 'politician') }
  }
  const th = (key, label) => (
    <th onClick={() => sortBy(key)} style={{ cursor: 'pointer', userSelect: 'none' }}>
      {label}{sortKey === key ? (asc ? ' ▲' : ' ▼') : ''}
    </th>
  )

  return (
    <SectionPanel title="Filing Speed by Politician" description="How quickly each member discloses. Disclosure lag reduces actionability.">
      <table>
        <thead>
          <tr>
            {th('politician', 'Politician')}
            {th('tradeCount', 'Trades')}
            {th('medianLagDays', 'Median lag (d)')}
            {th('pctWithin15', '≤15d')}
            {th('pctWithin30', '≤30d')}
            {th('pctWithin45', '≤45d')}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.politician}>
              <td>{r.politician}</td>
              <td>{r.tradeCount}</td>
              <td>{r.medianLagDays}</td>
              <td>{r.pctWithin15}%</td>
              <td>{r.pctWithin30}%</td>
              <td>{r.pctWithin45}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </SectionPanel>
  )
}

function AttributionChart({ attribution }) {
  if (!attribution || attribution.series.length === 0) return null
  // Merge each series' points into one row-per-week dataset for recharts
  const weeks = [...new Set(attribution.series.flatMap((s) => s.points.map((p) => p.week)))].sort()
  const data = weeks.map((week) => {
    const row = { week }
    for (const s of attribution.series) {
      const key = `${s.fund}/${s.source}`
      const upTo = s.points.filter((p) => p.week <= week)
      if (upTo.length) row[key] = upTo[upTo.length - 1].cumulativePnl
    }
    return row
  })
  return (
    <SectionPanel
      title="Realized P&L by Source"
      description={`Cumulative realized P&L from closed positions attributed to the opening signal source (${attribution.totalClosedLots} closed lots).`}
    >
      <div style={{ height: 240 }}>
        <ResponsiveContainer>
          <LineChart data={data}>
            <CartesianGrid stroke="var(--color-border-subtle)" />
            <XAxis dataKey="week" stroke="var(--color-text-muted)" fontSize={11} />
            <YAxis stroke="var(--color-text-muted)" fontSize={11} tickFormatter={(v) => `$${v}`} />
            <Tooltip contentStyle={{ background: '#111821', border: '1px solid #344255' }} />
            <Legend />
            <ReferenceLine y={0} stroke="var(--color-border-strong)" />
            {attribution.series.map((s, i) => (
              <Line
                key={`${s.fund}/${s.source}`}
                type="monotone"
                dataKey={`${s.fund}/${s.source}`}
                stroke={LINE_COLORS[i % LINE_COLORS.length]}
                dot={false}
                strokeWidth={2}
                connectNulls
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </SectionPanel>
  )
}

export function SignalTable({ signals, onAudit }) {
  if (signals.length === 0) return <p style={{ color: '#a1a1aa' }}>No signals yet</p>
  return (
    <table>
      <thead>
        <tr>
          <th>Time</th><th>Source</th><th>Ticker</th><th>Dir</th><th>Conf</th>
          <th>Relevance</th><th>Fund</th><th>Decision</th><th>Order</th><th>Why</th>
          {onAudit && <th></th>}
        </tr>
      </thead>
      <tbody>
        {signals.map((s, i) => {
          const relevance = s.sentimentClassification
          return (
            <tr key={`${s.id}-${s.fund ?? i}`}>
              <td style={{ whiteSpace: 'nowrap' }}>{s.created_at}</td>
              <td>{s.source}</td>
              <td>{s.ticker}</td>
              <td style={{ color: s.direction === 'buy' ? '#86efac' : '#fca5a5' }}>{s.direction}</td>
              <td>{s.confidence ?? '—'}</td>
              <td style={{ maxWidth: 160, color: '#a1a1aa', fontSize: '0.9em' }}>
                {relevance
                  ? (
                      <>
                        <div>{relevance.relevanceType} @ {relevance.marketRelevance}</div>
                        {relevance.sectors?.length > 0 && <div>{relevance.sectors.join(', ')}</div>}
                      </>
                    )
                  : '—'}
              </td>
              <td>{s.fund ?? '—'}</td>
              <td>{s.approved == null ? '—' : s.approved ? '✅' : '❌'}</td>
              <td>{s.order_status ?? '—'}</td>
              <td style={{ maxWidth: 420, color: '#a1a1aa' }}>
                <div>{s.decision_reason || s.rationale}</div>
                {s.crossSignal?.note && (
                  <div style={{ marginTop: 4, color: '#93c5fd', fontSize: '0.9em' }}>{s.crossSignal.note}</div>
                )}
              </td>
              {onAudit && (
                <td>
                  <button onClick={() => onAudit(s)} style={{ whiteSpace: 'nowrap' }}>Audit</button>
                </td>
              )}
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
