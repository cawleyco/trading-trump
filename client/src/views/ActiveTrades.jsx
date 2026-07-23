import { Fragment, useCallback, useEffect, useState } from 'react'
import { api } from '../api.js'
import { EmptyState, MetricCard, PageHeader, SectionPanel } from '../components/intel/components.jsx'
import { navigate } from '../lib/navigate.js'

const POLL_MS = 15000

export default function ActiveTrades() {
  const [status, setStatus] = useState(null)
  const [selectedFund, setSelectedFund] = useState('')
  const [expanded, setExpanded] = useState(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)
  const [lastUpdated, setLastUpdated] = useState(null)

  const refresh = useCallback(async ({ initial = false } = {}) => {
    if (initial) setLoading(true)
    else setRefreshing(true)
    try {
      const next = await api.status()
      setStatus(next)
      setLastUpdated(next.generatedAt ? new Date(next.generatedAt) : new Date())
      setError(null)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    refresh({ initial: true })
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') refresh()
    }, POLL_MS)
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [refresh])

  const funds = status?.funds || []
  const fund = funds.find((item) => item.name === selectedFund) || funds[0]
  const positions = fund?.positions || []
  const totals = positionTotals(positions, fund)

  if (loading && !status) return <p className="intel-muted">Loading broker positions…</p>

  return (
    <div>
      <PageHeader
        eyebrow="Trading / Monitor"
        title="Active Trades"
        description="Monitor broker positions, review exposure, and safely preview and confirm reductions, closes, exit rules, or order cancellations."
        meta={status
          ? `${status.tradingMode?.toUpperCase() || 'UNKNOWN'} mode · refreshes every 15 seconds while visible · ${freshness(lastUpdated)}`
          : 'Broker status unavailable'}
        actions={<button type="button" onClick={() => refresh()} disabled={refreshing}>{refreshing ? 'Refreshing…' : 'Refresh now'}</button>}
      />

      {error && (
        <div className="intel-panel" style={{ borderColor: 'var(--color-bearish)', color: 'var(--color-bearish)' }}>
          {status ? `Refresh failed; showing the last successful snapshot. ${error}` : error}
        </div>
      )}

      {funds.length === 0 ? (
        <SectionPanel>
          <EmptyState title="No funds reported" body="Check the fund configuration and server startup log." />
        </SectionPanel>
      ) : (
        <>
          <FundPicker funds={funds} selected={fund?.name} onSelect={(name) => { setSelectedFund(name); setExpanded(null) }} />
          <AccountState status={status} fund={fund} />

          <div className="intel-grid" style={{ marginBottom: 16 }}>
            <MetricCard label="Account equity" value={money(fund.equity)} helper={`${fund.name} · ${fund.paper ? 'paper' : 'LIVE'}`} tone="info" />
            <MetricCard label="Open positions" value={positions.length} helper={`${totals.capacityPositions} position slots available`} />
            <MetricCard label="Open exposure" value={money(totals.exposure)} helper={`${percent(totals.exposureUsage)} of configured limit`} tone={totals.exposureUsage >= 90 ? 'bad' : totals.exposureUsage >= 70 ? 'warning' : 'neutral'} />
            <MetricCard label="Unrealized P&L" value={signedMoney(totals.unrealizedPl)} helper={`${signedPercent(totals.unrealizedPlPct)} on open cost basis`} tone={totals.unrealizedPl < 0 ? 'bad' : 'good'} />
            <MetricCard label="Today’s P&L" value={signedMoney(todayPnl(fund))} helper={fund.dailyPnl ? 'Realized + unrealized' : 'No daily snapshot reported'} tone={todayPnl(fund) < 0 ? 'bad' : 'good'} />
            <MetricCard label="Buying power" value={money(fund.buyingPower)} helper={`${money(totals.exposureCapacity)} exposure capacity by risk limit`} />
          </div>

          <SectionPanel
            title={`Open Positions — ${fund.name}`}
            description="Values come directly from the configured broker account. Select a row for broker and risk detail."
          >
            {fund.error ? (
              <EmptyState title="Broker account unavailable" body={fund.error} />
            ) : positions.length === 0 ? (
              <EmptyState title="No active trades" body="The broker reports no open positions for this fund." />
            ) : (
              <div className="intel-table-wrap">
                <table className="intel-table">
                  <thead>
                    <tr>
                      <th>Symbol</th><th>Side</th><th className="is-numeric">Qty</th><th className="is-numeric">Avg entry</th>
                      <th className="is-numeric">Current</th><th className="is-numeric">Market value</th><th className="is-numeric">Allocation</th>
                      <th className="is-numeric">Unrealized P&L</th><th className="is-numeric">Today</th><th aria-label="Details" />
                    </tr>
                  </thead>
                  <tbody>
                    {positions.map((position) => {
                      const key = `${fund.name}:${position.symbol}`
                      const open = expanded === key
                      return (
                        <Fragment key={key}>
                          <tr>
                            <td className="is-mono"><strong>{position.symbol}</strong></td>
                            <td><PositionSide side={position.side} /></td>
                            <td className="is-numeric is-mono">{number(position.qty, 4)}</td>
                            <td className="is-numeric is-mono">{money(position.avgEntry)}</td>
                            <td className="is-numeric is-mono">{money(position.currentPrice)}</td>
                            <td className="is-numeric is-mono">{money(Math.abs(position.marketValue))}</td>
                            <td className="is-numeric is-mono">{percent(allocation(position, fund))}</td>
                            <td className="is-numeric is-mono"><Pnl value={position.unrealizedPl} pct={position.unrealizedPlPct} /></td>
                            <td className="is-numeric is-mono"><Pnl pct={position.changeTodayPct} /></td>
                            <td><button type="button" onClick={() => setExpanded(open ? null : key)} aria-expanded={open}>{open ? 'Hide' : 'Details'}</button></td>
                          </tr>
                          {open && <PositionDetails position={position} fund={fund} onRefresh={() => refresh()} />}
                        </Fragment>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </SectionPanel>

          <RiskCapacity fund={fund} totals={totals} />
        </>
      )}
    </div>
  )
}

function FundPicker({ funds, selected, onSelect }) {
  if (funds.length === 1) return null
  return (
    <div className="intel-tabs" aria-label="Fund selector">
      {funds.map((fund) => (
        <button type="button" key={fund.name} className={`intel-tab ${selected === fund.name ? 'is-active' : ''}`} onClick={() => onSelect(fund.name)}>
          {fund.name} · {fund.paper ? 'PAPER' : 'LIVE'}
        </button>
      ))}
    </div>
  )
}

function AccountState({ status, fund }) {
  const halted = status.globallyHalted || fund.halted
  const live = !fund.paper
  return (
    <div className="intel-panel" style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', borderColor: halted || live ? 'var(--color-warning)' : undefined }}>
      <strong style={{ color: halted ? 'var(--color-bearish)' : live ? 'var(--color-warning)' : 'var(--color-bullish)' }}>
        {halted ? 'TRADING HALTED' : live ? 'LIVE ACCOUNT' : 'PAPER ACCOUNT'}
      </strong>
      <span className="intel-muted">
        {halted ? (fund.haltReason || 'A kill switch is active.') : 'Position changes require a fresh broker preview and explicit confirmation.'}
      </span>
    </div>
  )
}

function PositionDetails({ position, fund, onRefresh }) {
  return (
    <tr>
      <td colSpan={10} style={{ background: 'var(--color-bg-subtle)' }}>
        <div className="intel-grid" style={{ marginBottom: 12 }}>
          <Detail label="Cost basis" value={money(position.costBasis)} />
          <Detail label="Entry → current" value={`${money(position.avgEntry)} → ${money(position.currentPrice)}`} />
          <Detail label="Asset / exchange" value={[position.assetClass, position.exchange].filter(Boolean).join(' · ') || 'Not reported'} />
          <Detail label="Auto-exit policy" value={autoExit(position.exitRule || fund.autoExit)} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="intel-muted">Signal-to-position provenance will be joined to individual fills in Trade History.</span>
          <button type="button" onClick={() => navigate('/app/signals')}>Open signal audit log</button>
        </div>
        <PositionActions position={position} fund={fund} onComplete={onRefresh} />
      </td>
    </tr>
  )
}

function PositionActions({ position, fund, onComplete }) {
  const initialRule = position.exitRule || fund.autoExit || {}
  const [action, setAction] = useState('close')
  const [quantity, setQuantity] = useState('')
  const [rule, setRule] = useState({ stopLossPct: initialRule.stopLossPct ?? '', takeProfitPct: initialRule.takeProfitPct ?? '', maxHoldDays: initialRule.maxHoldDays ?? '' })
  const [preview, setPreview] = useState(null)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const body = () => ({ fund: fund.name, ticker: position.symbol, action, quantity, ...rule })
  const runPreview = async () => {
    setBusy(true); setError(null); setResult(null)
    try { setPreview(await api.previewPositionAction(body())) } catch (err) { setError(err.message); setPreview(null) }
    finally { setBusy(false) }
  }
  const confirm = async () => {
    setBusy(true); setError(null)
    try {
      const response = await api.confirmPositionAction({ ...body(), confirmed: true, expectedQty: preview.position.qty, idempotencyKey: crypto.randomUUID() })
      setResult(response); setPreview(null); onComplete()
    } catch (err) { setError(err.message) }
    finally { setBusy(false) }
  }
  return <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--color-border-subtle)' }}>
    <strong>Position controls</strong>
    <p className="intel-muted" style={{ margin: '4px 0 10px' }}>Every change requires a fresh broker preview and explicit confirmation.</p>
    <div style={{ display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap' }}>
      <label style={controlLabel}>Action<select value={action} onChange={(e) => { setAction(e.target.value); setPreview(null) }}><option value="close">Close position</option><option value="reduce">Reduce position</option><option value="update-exit">Edit exit rules</option><option value="cancel-orders">Cancel open orders</option></select></label>
      {action === 'reduce' && <label style={controlLabel}>Quantity<input type="number" min="0" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} /></label>}
      {action === 'update-exit' && <>
        <label style={controlLabel}>Stop loss %<input type="number" min="0" step="0.1" value={rule.stopLossPct} onChange={(e) => setRule((r) => ({ ...r, stopLossPct: e.target.value }))} /></label>
        <label style={controlLabel}>Take profit %<input type="number" min="0" step="0.1" value={rule.takeProfitPct} onChange={(e) => setRule((r) => ({ ...r, takeProfitPct: e.target.value }))} /></label>
        <label style={controlLabel}>Max hold days<input type="number" min="0" step="1" value={rule.maxHoldDays} onChange={(e) => setRule((r) => ({ ...r, maxHoldDays: e.target.value }))} /></label>
      </>}
      <button type="button" onClick={runPreview} disabled={busy}>{busy ? 'Checking…' : 'Preview change'}</button>
    </div>
    {error && <p style={{ color: 'var(--color-bearish)' }}>{error}</p>}
    {preview && <div style={{ marginTop: 12, padding: 12, border: `1px solid ${preview.warning ? 'var(--color-bearish)' : 'var(--color-warning)'}`, borderRadius: 6 }}>
      <strong>{preview.warning || `${preview.executionMode.toUpperCase()} confirmation`}</strong>
      <div className="intel-muted">Broker quantity {preview.position.qty}{preview.quantity != null ? ` · sell ${preview.quantity} · remaining ${preview.remainingQty}` : ''}</div>
      <button type="button" onClick={confirm} disabled={busy} style={{ marginTop: 8 }}>{busy ? 'Submitting…' : `Confirm ${action.replace('-', ' ')}`}</button>
    </div>}
    {result && <p style={{ color: 'var(--color-bullish)' }}>Completed: {result.status}{result.brokerOrderId ? ` · broker order ${result.brokerOrderId}` : ''}</p>}
  </div>
}

function RiskCapacity({ fund, totals }) {
  return (
    <SectionPanel title="Risk Capacity" description={`Configured limits and remaining capacity for ${fund.name}.`}>
      <table>
        <tbody>
          <tr><td>Position slots</td><td>{fund.positions.length} / {fund.risk?.maxOpenPositions ?? '—'}</td></tr>
          <tr><td>Total exposure</td><td>{money(totals.exposure)} / {money(fund.risk?.maxTotalExposureUsd)}</td></tr>
          <tr><td>Remaining exposure capacity</td><td>{money(totals.exposureCapacity)}</td></tr>
          <tr><td>Maximum per trade</td><td>{money(fund.risk?.maxTradeNotionalUsd)} or {percent(fund.risk?.maxTradePctEquity)}</td></tr>
          <tr><td>Daily loss limit</td><td>{money(fund.risk?.maxDailyLossUsd)} or {percent(fund.risk?.maxDailyLossPct)}</td></tr>
          <tr><td>Enabled sources</td><td>{fund.sources?.join(', ') || 'None'}</td></tr>
        </tbody>
      </table>
    </SectionPanel>
  )
}

function Detail({ label, value }) {
  return <div><div className="intel-muted" style={{ fontSize: '0.78em' }}>{label}</div><strong>{value}</strong></div>
}

function PositionSide({ side }) {
  const short = side === 'short'
  return <span style={{ color: short ? 'var(--color-bearish)' : 'var(--color-bullish)' }}>{short ? 'SHORT' : 'LONG'}</span>
}

function Pnl({ value, pct }) {
  const comparison = isNumeric(value) ? Number(value) : Number(pct)
  const parts = []
  if (isNumeric(value)) parts.push(signedMoney(value))
  if (isNumeric(pct)) parts.push(signedPercent(pct))
  return <span style={{ color: comparison < 0 ? 'var(--color-bearish)' : 'var(--color-bullish)' }}>{parts.join(' · ') || '—'}</span>
}

function positionTotals(positions, fund) {
  const exposure = positions.reduce((sum, p) => sum + Math.abs(finite(p.marketValue)), 0)
  const unrealizedPl = positions.reduce((sum, p) => sum + finite(p.unrealizedPl), 0)
  const costBasis = positions.reduce((sum, p) => sum + Math.abs(finite(p.costBasis)), 0)
  const limit = finite(fund?.risk?.maxTotalExposureUsd)
  return {
    exposure,
    unrealizedPl,
    unrealizedPlPct: costBasis ? (unrealizedPl / costBasis) * 100 : 0,
    exposureUsage: limit ? (exposure / limit) * 100 : 0,
    exposureCapacity: limit ? Math.max(0, limit - exposure) : 0,
    capacityPositions: Math.max(0, finite(fund?.risk?.maxOpenPositions) - positions.length),
  }
}

function allocation(position, fund) {
  return finite(fund?.equity) ? (Math.abs(finite(position.marketValue)) / finite(fund.equity)) * 100 : 0
}

function todayPnl(fund) {
  return finite(fund?.dailyPnl?.realized_pnl) + finite(fund?.dailyPnl?.unrealized_pnl)
}

function autoExit(policy) {
  if (!policy) return 'Off'
  return `SL ${policy.stopLossPct ?? '—'}% · TP ${policy.takeProfitPct ?? '—'}% · max ${policy.maxHoldDays ?? '—'}d`
}

function freshness(date) {
  if (!date) return 'not yet refreshed'
  return `updated ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
}

function finite(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function number(value, digits = 2) {
  if (!isNumeric(value)) return '—'
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: digits })
}

function money(value) {
  if (!isNumeric(value)) return '—'
  return Number(value).toLocaleString(undefined, { style: 'currency', currency: 'USD' })
}

function signedMoney(value) {
  if (!isNumeric(value)) return '—'
  return `${Number(value) >= 0 ? '+' : '-'}${money(Math.abs(Number(value)))}`
}

function percent(value) {
  if (!isNumeric(value)) return '—'
  return `${number(value)}%`
}

function signedPercent(value) {
  if (!isNumeric(value)) return '—'
  return `${Number(value) >= 0 ? '+' : ''}${number(value)}%`
}

const controlLabel = { display: 'grid', gap: 4, fontSize: '0.78em', color: 'var(--color-text-muted)' }

function isNumeric(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
}
