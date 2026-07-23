import { useEffect, useState } from 'react'
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { api } from '../api.js'
import { EmptyState, MetricCard, PageHeader, SectionPanel } from '../components/intel/components.jsx'

export default function Performance() {
  const [fund, setFund] = useState('')
  const [range, setRange] = useState({ from: '', to: '' })
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = async (nextFund = fund) => {
    setLoading(true); setError(null)
    try {
      const result = await api.performance({ ...range, fund: nextFund })
      setData(result)
      if (!nextFund && result.fund) setFund(result.fund)
    } catch (err) { setError(err.message) }
    finally { setLoading(false) }
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const summary = data?.summary || {}
  return <div>
    <PageHeader eyebrow="Trading / Analytics" title="Performance" description="Realized results from FIFO-matched broker fills, kept separate by fund and account mode." meta={data ? `${data.fund} · ${data.from || 'start'} to ${data.to || 'present'} · ${summary.closedTrades || 0} closed trades` : 'Loading performance'} actions={<button onClick={() => load()} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button>} />
    <SectionPanel title="Scope" description="Paper and live accounts are never combined by default.">
      <div style={{ display: 'flex', gap: 10, alignItems: 'end', flexWrap: 'wrap' }}>
        <Label text="Fund"><select value={fund} onChange={(e) => { setFund(e.target.value); load(e.target.value) }}>{(data?.funds || []).map((item) => <option key={item.name} value={item.name}>{item.name} · {item.paper ? 'PAPER' : 'LIVE'}</option>)}</select></Label>
        <Label text="From"><input type="date" value={range.from} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} /></Label>
        <Label text="To"><input type="date" value={range.to} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} /></Label>
        <button onClick={() => load()}>Apply</button>
      </div>
    </SectionPanel>
    {error && <div className="intel-panel" style={{ color: 'var(--color-bearish)' }}>{error}</div>}
    {data && <>
      <div className="intel-grid" style={{ marginBottom: 16 }}>
        <MetricCard label="Net realized P&L" value={money(summary.netPnl)} helper={`${pct(summary.returnPct)} return`} tone={summary.netPnl < 0 ? 'bad' : 'good'} />
        <MetricCard label="Win rate" value={pct(summary.winRate)} helper={`${summary.closedTrades} closed trades`} />
        <MetricCard label="Profit factor" value={num(summary.profitFactor)} helper={`Payoff ratio ${num(summary.payoffRatio)}`} />
        <MetricCard label="Maximum drawdown" value={money(summary.maxDrawdown)} helper="Peak-to-trough realized P&L" tone="warning" />
        <MetricCard label="Sharpe ratio" value={summary.sharpe == null ? 'Insufficient data' : num(summary.sharpe)} helper={`${summary.sharpeSampleDays} daily observations`} />
        <MetricCard label="SPY comparison" value={data.benchmark.unavailable ? 'Unavailable' : pct(data.benchmark.excessReturnPct)} helper={data.benchmark.unavailable ? 'Benchmark price data unavailable' : `Excess return · SPY ${pct(data.benchmark.returnPct)}`} tone="info" />
      </div>
      <SectionPanel title="Realized P&L Curve" description="Cumulative closed-lot profit and drawdown; open-position P&L is intentionally excluded.">
        {data.curve.length ? <Chart data={data.curve} /> : <EmptyState title="No closed trades" body="There are no FIFO-matched exits in this scope." />}
      </SectionPanel>
      <div className="intel-dashboard-grid">
        <Breakdown title="By source" rows={data.groups.source} />
        <Breakdown title="By ticker" rows={data.groups.ticker} />
        <Breakdown title="By strategy" rows={data.groups.strategy} />
        <Breakdown title="By YouTube creator" rows={data.groups.creator} />
      </div>
    </>}
  </div>
}

function Chart({ data }) { return <div style={{ height: 300 }}><ResponsiveContainer><LineChart data={data}><CartesianGrid stroke="var(--color-border-subtle)" /><XAxis dataKey="date" stroke="var(--color-text-muted)" /><YAxis stroke="var(--color-text-muted)" tickFormatter={(v) => `$${v}`} /><Tooltip contentStyle={{ background: 'var(--color-bg-panel)', border: '1px solid var(--color-border-strong)' }} /><ReferenceLine y={0} stroke="var(--color-border-strong)" /><Line dataKey="cumulativePnl" stroke="var(--color-bullish)" dot={false} strokeWidth={2} /><Line dataKey="drawdown" stroke="var(--color-bearish)" dot={false} strokeWidth={1} /></LineChart></ResponsiveContainer></div> }
function Breakdown({ title, rows }) { return <SectionPanel title={title}>{rows.length ? <div className="intel-table-wrap"><table className="intel-table"><thead><tr><th>Name</th><th>Trades</th><th>Win rate</th><th>P&L</th><th>Return</th></tr></thead><tbody>{rows.map((row) => <tr key={row.key}><td>{row.key}</td><td>{row.closedTrades}</td><td>{pct(row.winRate)}</td><td style={{ color: row.netPnl < 0 ? 'var(--color-bearish)' : 'var(--color-bullish)' }}>{money(row.netPnl)}</td><td>{pct(row.returnPct)}</td></tr>)}</tbody></table></div> : <p className="intel-muted">No attributable closed trades.</p>}</SectionPanel> }
function Label({ text, children }) { return <label style={{ display: 'grid', gap: 4, fontSize: '0.8em', color: 'var(--color-text-muted)' }}>{text}{children}</label> }
function money(value) { return value == null ? '—' : Number(value).toLocaleString(undefined, { style: 'currency', currency: 'USD' }) }
function pct(value) { return value == null ? '—' : `${Number(value).toFixed(2)}%` }
function num(value) { return value == null ? '—' : Number(value).toFixed(2) }
