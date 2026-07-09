import { useEffect, useState } from 'react'
import {
  LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer, ReferenceLine, Legend,
} from 'recharts'
import { api } from '../api.js'

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

  if (!status) return <p>Loading…</p>

  const fund = status.funds.find((f) => f.name === selectedFund) || status.funds[0]

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
      {status.funds.length > 1 && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center' }}>
          <span style={{ color: '#a1a1aa', fontSize: '0.85em' }}>Fund:</span>
          {status.funds.map((f) => (
            <button
              key={f.name}
              onClick={() => setSelectedFund(f.name)}
              style={f.name === fund.name ? { borderColor: '#6366f1', background: '#26283a' } : {}}
            >
              {f.name}
            </button>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
        <section style={card}>
          <h3>Open Positions — {fund.name}</h3>
          {fund.positions.length === 0 ? (
            <p style={{ color: '#a1a1aa' }}>No open positions</p>
          ) : (
            <table>
              <thead>
                <tr><th>Symbol</th><th>Qty</th><th>Value</th><th>Unrealized P&L</th></tr>
              </thead>
              <tbody>
                {fund.positions.map((p) => (
                  <tr key={p.symbol}>
                    <td>{p.symbol}</td>
                    <td>{p.qty}</td>
                    <td>${p.marketValue.toFixed(2)}</td>
                    <td style={{ color: p.unrealizedPl < 0 ? '#fca5a5' : '#86efac' }}>
                      {p.unrealizedPl >= 0 ? '+' : ''}{p.unrealizedPl.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section style={card}>
          <h3>Limits — {fund.name}</h3>
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
        </section>

        <section style={card}>
          <h3>Pipeline Test</h3>
          <p style={{ color: '#a1a1aa', fontSize: '0.85em' }}>
            Fire a manual signal at fund "{fund.name}" through the full risk pipeline (respects current mode).
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <input value={testTicker} onChange={(e) => setTestTicker(e.target.value.toUpperCase())} style={{ width: 90 }} />
            <button onClick={fireTestSignal}>Send test buy signal</button>
          </div>
          {testResult && (
            <pre style={{ fontSize: '0.75em', background: '#16181d', padding: 10, borderRadius: 6, overflow: 'auto' }}>
              {JSON.stringify(testResult, null, 2)}
            </pre>
          )}
        </section>
      </div>

      <AttributionChart attribution={attribution} />

      <FilingSpeedTable rows={filingSpeed} />

      <section style={{ ...card, marginTop: 24, maxWidth: 'none' }}>
        <h3>Recent Signals</h3>
        <SignalTable signals={signals} />
      </section>
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
    <section style={{ ...card, marginTop: 24, maxWidth: 'none' }}>
      <h3>Filing speed by politician</h3>
      <p style={{ color: '#a1a1aa', fontSize: '0.85em' }}>
        How quickly each member discloses. Faster filers give copyable signals a shorter head start to erode.
      </p>
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
    </section>
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
    <section style={{ ...card, marginTop: 24, maxWidth: 'none' }}>
      <h3>Realized P&L by source</h3>
      <p style={{ color: '#a1a1aa', fontSize: '0.85em' }}>
        Cumulative realized P&L from closed positions, attributed to the signal source that opened them
        ({attribution.totalClosedLots} closed lots).
      </p>
      <div style={{ height: 240 }}>
        <ResponsiveContainer>
          <LineChart data={data}>
            <CartesianGrid stroke="#26282f" />
            <XAxis dataKey="week" stroke="#a1a1aa" fontSize={11} />
            <YAxis stroke="#a1a1aa" fontSize={11} tickFormatter={(v) => `$${v}`} />
            <Tooltip contentStyle={{ background: '#1f2229', border: '1px solid #3f3f46' }} />
            <Legend />
            <ReferenceLine y={0} stroke="#52525b" />
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
    </section>
  )
}

export function SignalTable({ signals }) {
  if (signals.length === 0) return <p style={{ color: '#a1a1aa' }}>No signals yet</p>
  return (
    <table>
      <thead>
        <tr>
          <th>Time</th><th>Source</th><th>Ticker</th><th>Dir</th><th>Conf</th>
          <th>Relevance</th><th>Fund</th><th>Decision</th><th>Order</th><th>Why</th>
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
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

const card = {
  background: '#16181d',
  border: '1px solid #26282f',
  borderRadius: 10,
  padding: '16px 20px',
  flex: 1,
  minWidth: 300,
}
