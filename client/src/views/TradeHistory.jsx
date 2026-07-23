import { Fragment, useCallback, useEffect, useState } from 'react'
import { api } from '../api.js'
import { EmptyState, MetricCard, PageHeader, SectionPanel } from '../components/intel/components.jsx'
import { navigate } from '../lib/navigate.js'

const PAGE_SIZE = 50
const EMPTY_FILTERS = { from: '', to: '', fund: '', ticker: '', source: '', creator: '', strategy: '', side: '', status: '' }

export default function TradeHistory() {
  const [filters, setFilters] = useState(EMPTY_FILTERS)
  const [applied, setApplied] = useState(EMPTY_FILTERS)
  const [page, setPage] = useState(0)
  const [data, setData] = useState({ rows: [], total: 0 })
  const [expanded, setExpanded] = useState(null)
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setData(await api.tradeHistory({ ...applied, limit: PAGE_SIZE, offset: page * PAGE_SIZE }))
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [applied, page])

  useEffect(() => { load() }, [load])

  const apply = (event) => {
    event.preventDefault()
    setPage(0)
    setExpanded(null)
    setApplied({ ...filters, ticker: filters.ticker.toUpperCase().trim() })
  }

  const reset = () => {
    setFilters(EMPTY_FILTERS)
    setApplied(EMPTY_FILTERS)
    setPage(0)
    setExpanded(null)
  }

  const exportCsv = async () => {
    setExporting(true)
    setError(null)
    try {
      const result = await api.tradeHistory({ ...applied, limit: 5000, offset: 0 })
      downloadCsv(result.rows)
    } catch (err) {
      setError(err.message)
    } finally {
      setExporting(false)
    }
  }

  const rows = data.rows || []
  const filled = rows.filter((row) => row.filledQty != null).length
  const rejected = rows.filter((row) => row.status === 'rejected').length
  const pageRealized = rows.reduce((sum, row) => sum + (Number(row.realizedPnl) || 0), 0)

  return (
    <div>
      <PageHeader
        eyebrow="Trading / Audit"
        title="Trade History"
        description="Executed and attempted trading activity joined to its originating signal, risk decision, order, and latest fill."
        meta={`${data.total || 0} matching records · newest first · P&L uses FIFO-matched closed lots`}
        actions={(
          <>
            <button type="button" onClick={load} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</button>
            <button type="button" onClick={exportCsv} disabled={exporting || data.total === 0}>{exporting ? 'Exporting…' : 'Export CSV'}</button>
          </>
        )}
      />

      <SectionPanel title="Filters" description="Narrow by execution date and trading provenance.">
        <form onSubmit={apply} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'end' }}>
          <Filter label="From"><input type="date" value={filters.from} onChange={(e) => setFilter(setFilters, 'from', e.target.value)} /></Filter>
          <Filter label="To"><input type="date" value={filters.to} onChange={(e) => setFilter(setFilters, 'to', e.target.value)} /></Filter>
          <Filter label="Fund"><input value={filters.fund} onChange={(e) => setFilter(setFilters, 'fund', e.target.value)} placeholder="Any" /></Filter>
          <Filter label="Ticker"><input value={filters.ticker} onChange={(e) => setFilter(setFilters, 'ticker', e.target.value.toUpperCase())} placeholder="Any" style={{ width: 90 }} /></Filter>
          <Filter label="Source">
            <select value={filters.source} onChange={(e) => setFilter(setFilters, 'source', e.target.value)}>
              <option value="">Any</option><option value="youtube">YouTube</option><option value="congress">Congress</option>
              <option value="sentiment">Sentiment</option><option value="manual">Manual</option><option value="strategy">Strategy</option>
            </select>
          </Filter>
          <Filter label="Creator"><input value={filters.creator} onChange={(e) => setFilter(setFilters, 'creator', e.target.value)} placeholder="Any" /></Filter>
          <Filter label="Strategy"><input value={filters.strategy} onChange={(e) => setFilter(setFilters, 'strategy', e.target.value)} placeholder="Any" /></Filter>
          <Filter label="Side">
            <select value={filters.side} onChange={(e) => setFilter(setFilters, 'side', e.target.value)}><option value="">Any</option><option value="buy">Buy</option><option value="sell">Sell</option></select>
          </Filter>
          <Filter label="Status">
            <select value={filters.status} onChange={(e) => setFilter(setFilters, 'status', e.target.value)}>
              <option value="">Any</option><option value="filled">Filled</option><option value="partially_filled">Partially filled</option>
              <option value="submitted">Submitted</option><option value="simulated">Simulated</option><option value="rejected">Rejected</option>
              <option value="canceled">Canceled</option><option value="expired">Expired</option><option value="error">Error</option><option value="no_order">No order</option>
            </select>
          </Filter>
          <button type="submit">Apply</button>
          <button type="button" onClick={reset}>Reset</button>
        </form>
      </SectionPanel>

      <div className="intel-grid" style={{ marginBottom: 16 }}>
        <MetricCard label="Records on page" value={rows.length} helper={`${data.total || 0} across all pages`} tone="info" />
        <MetricCard label="Filled on page" value={filled} helper="Records with broker fill data" />
        <MetricCard label="Rejected on page" value={rejected} helper="Risk or broker rejection" tone={rejected ? 'warning' : 'neutral'} />
        <MetricCard label="Realized P&L on page" value={signedMoney(pageRealized)} helper="FIFO-matched sell orders" tone={pageRealized < 0 ? 'bad' : 'good'} />
      </div>

      {error && <div className="intel-panel" style={{ color: 'var(--color-bearish)', borderColor: 'var(--color-bearish)' }}>{error}</div>}

      <SectionPanel title="Orders and Decisions" description="Rejected decisions appear even when risk controls prevented an order from being created.">
        {loading && rows.length === 0 ? (
          <p className="intel-muted">Loading trade history…</p>
        ) : rows.length === 0 ? (
          <EmptyState title="No trading activity" body="No decisions or orders match the selected filters." />
        ) : (
          <div className="intel-table-wrap">
            <table className="intel-table">
              <thead><tr>
                <th>Time</th><th>Fund</th><th>Source</th><th>Ticker</th><th>Side</th><th>Status</th>
                <th className="is-numeric">Notional</th><th className="is-numeric">Fill</th><th className="is-numeric">Realized P&L</th><th className="is-numeric">Hold</th><th />
              </tr></thead>
              <tbody>
                {rows.map((row) => (
                  <Fragment key={row.id}>
                    <tr>
                      <td style={{ whiteSpace: 'nowrap' }}>{formatTime(row.submittedAt)}</td>
                      <td>{row.fund}</td><td>{row.source}</td><td className="is-mono"><strong>{row.ticker}</strong></td>
                      <td><Side value={row.side} /></td><td><Status value={row.status} /></td>
                      <td className="is-numeric is-mono">{money(row.notionalUsd)}</td>
                      <td className="is-numeric is-mono">{row.filledQty == null ? '—' : `${number(row.filledQty, 4)} @ ${money(row.filledAvgPrice)}`}</td>
                      <td className="is-numeric is-mono"><Pnl value={row.realizedPnl} pct={row.returnPct} /></td>
                      <td className="is-numeric is-mono">{row.holdingDays == null ? '—' : `${number(row.holdingDays, 1)}d`}</td>
                      <td><button type="button" onClick={() => setExpanded(expanded === row.id ? null : row.id)}>{expanded === row.id ? 'Hide' : 'Details'}</button></td>
                    </tr>
                    {expanded === row.id && <HistoryDetail row={row} />}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pager page={page} total={data.total || 0} onPage={setPage} />
      </SectionPanel>
    </div>
  )
}

function HistoryDetail({ row }) {
  const youtubeVideoId = row.source === 'youtube' ? row.rawReference?.videoId : null
  return (
    <tr><td colSpan={11} style={{ background: 'var(--color-bg-subtle)' }}>
      <div className="intel-grid" style={{ marginBottom: 14 }}>
        <Detail label="Signal" value={`#${row.signalId} · ${row.rationale || 'No rationale'}`} />
        <Detail label="Decision" value={`#${row.decisionId} · ${row.approved ? 'approved' : 'rejected'}`} />
        <Detail label="Order" value={row.orderId ? `#${row.orderId}${row.alpacaOrderId ? ` · broker ${row.alpacaOrderId}` : ''}` : 'Not created'} />
        <Detail label="Entry → exit" value={`${money(row.entryPrice)} → ${money(row.exitPrice)}`} />
      </div>
      <div style={{ marginBottom: 12 }}><strong>Decision reason</strong><div className="intel-muted">{row.decisionReason}</div></div>
      {row.checks?.length > 0 && (
        <div style={{ marginBottom: 12 }}><strong>Risk checks</strong><ol style={{ margin: '6px 0 0 18px' }}>
          {row.checks.map((check, index) => <li key={`${check.check}-${index}`} style={{ color: check.pass ? 'var(--color-bullish)' : 'var(--color-bearish)' }}>{check.pass ? 'pass' : 'fail'} · {check.check}: <span className="intel-muted">{check.detail}</span></li>)}
        </ol></div>
      )}
      {row.rawReference && <details><summary>Source reference</summary><pre style={pre}>{JSON.stringify(row.rawReference, null, 2)}</pre></details>}
      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <button type="button" onClick={() => navigate('/app/signals')}>Open signal audit log</button>
        {youtubeVideoId && <button type="button" onClick={() => navigate(`/app/influence/youtube/videos/${youtubeVideoId}`)}>Open YouTube video analysis</button>}
      </div>
    </td></tr>
  )
}

function Pager({ page, total, onPage }) {
  const pages = Math.ceil(total / PAGE_SIZE)
  if (pages <= 1) return null
  return <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 10, marginTop: 14 }}>
    <button type="button" onClick={() => onPage(page - 1)} disabled={page === 0}>Previous</button>
    <span className="intel-muted">Page {page + 1} of {pages}</span>
    <button type="button" onClick={() => onPage(page + 1)} disabled={page + 1 >= pages}>Next</button>
  </div>
}

function Filter({ label, children }) { return <label style={{ display: 'grid', gap: 4, fontSize: '0.8em', color: 'var(--color-text-muted)' }}>{label}{children}</label> }
function Detail({ label, value }) { return <div><div className="intel-muted" style={{ fontSize: '0.78em' }}>{label}</div><strong>{value}</strong></div> }
function setFilter(setter, key, value) { setter((current) => ({ ...current, [key]: value })) }
function Side({ value }) { return <span style={{ color: value === 'sell' ? 'var(--color-bearish)' : 'var(--color-bullish)' }}>{String(value || '—').toUpperCase()}</span> }
function Status({ value }) {
  const color = value === 'filled' ? 'var(--color-bullish)' : ['rejected', 'error', 'canceled'].includes(value) ? 'var(--color-bearish)' : 'var(--color-warning)'
  return <span style={{ color }}>{String(value || '—').replaceAll('_', ' ')}</span>
}
function Pnl({ value, pct }) {
  if (value == null) return '—'
  return <span style={{ color: Number(value) < 0 ? 'var(--color-bearish)' : 'var(--color-bullish)' }}>{signedMoney(value)}{pct == null ? '' : ` · ${signedPercent(pct)}`}</span>
}
function formatTime(value) { return value ? new Date(`${value}${value.includes('T') ? '' : 'Z'}`).toLocaleString() : '—' }
function number(value, digits = 2) { return value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toLocaleString(undefined, { maximumFractionDigits: digits }) }
function money(value) { return value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toLocaleString(undefined, { style: 'currency', currency: 'USD' }) }
function signedMoney(value) { return value == null ? '—' : `${Number(value) >= 0 ? '+' : '-'}${money(Math.abs(Number(value)))}` }
function signedPercent(value) { return value == null ? '—' : `${Number(value) >= 0 ? '+' : ''}${number(value)}%` }

function downloadCsv(rows) {
  const columns = [
    ['submitted_at', (r) => r.submittedAt], ['fund', (r) => r.fund], ['source', (r) => r.source], ['ticker', (r) => r.ticker],
    ['side', (r) => r.side], ['status', (r) => r.status], ['notional_usd', (r) => r.notionalUsd], ['filled_qty', (r) => r.filledQty],
    ['filled_avg_price', (r) => r.filledAvgPrice], ['entry_price', (r) => r.entryPrice], ['exit_price', (r) => r.exitPrice],
    ['realized_pnl', (r) => r.realizedPnl], ['return_pct', (r) => r.returnPct], ['holding_days', (r) => r.holdingDays],
    ['signal_id', (r) => r.signalId], ['decision_id', (r) => r.decisionId], ['order_id', (r) => r.orderId], ['broker_order_id', (r) => r.alpacaOrderId],
    ['rationale', (r) => r.rationale], ['decision_reason', (r) => r.decisionReason],
  ]
  const csv = [columns.map(([name]) => name), ...rows.map((row) => columns.map(([, read]) => read(row)))].map((line) => line.map(csvCell).join(',')).join('\n')
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `trade-history-${new Date().toISOString().slice(0, 10)}.csv`
  anchor.click()
  URL.revokeObjectURL(url)
}

function csvCell(value) { return `"${String(value ?? '').replaceAll('"', '""')}"` }
const pre = { fontSize: '0.75em', background: 'var(--color-bg-panel)', padding: 10, borderRadius: 6, overflow: 'auto', maxHeight: 240 }
