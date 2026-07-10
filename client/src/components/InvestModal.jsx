import { useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'

const LAST_FUND_KEY = 'invest.lastFund'

function loadLastFund() {
  try {
    return localStorage.getItem(LAST_FUND_KEY) || ''
  } catch {
    return ''
  }
}

function saveLastFund(name) {
  try {
    localStorage.setItem(LAST_FUND_KEY, name)
  } catch {
    /* ignore */
  }
}

function pickDefaultFund(funds, preferred) {
  if (!funds?.length) return ''
  if (preferred && funds.some((f) => f.name === preferred)) return preferred
  const paper = funds.find((f) => f.paper)
  return paper?.name || funds[0].name
}

/**
 * Two-step invest modal: configure → preview risk checks → confirm.
 *
 * props:
 *  open, onClose
 *  ticker, direction?, notionalUsd?, rationale?, origin?
 */
export default function InvestModal({
  open,
  onClose,
  ticker,
  direction: initialDirection = 'buy',
  notionalUsd: initialNotional = null,
  rationale = '',
  origin = { kind: 'manual' },
}) {
  const [fundsInfo, setFundsInfo] = useState(null)
  const [fund, setFund] = useState('')
  const [direction, setDirection] = useState(initialDirection)
  const [notional, setNotional] = useState(initialNotional ?? '')
  const [preview, setPreview] = useState(null)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setDirection(initialDirection || 'buy')
    setNotional(initialNotional ?? '')
    setPreview(null)
    setResult(null)
    setError(null)
    api.investFunds()
      .then((info) => {
        setFundsInfo(info)
        setFund(pickDefaultFund(info.funds, loadLastFund()))
      })
      .catch((e) => setError(e.message))
  }, [open, initialDirection, initialNotional, ticker])

  const selectedFund = useMemo(
    () => fundsInfo?.funds?.find((f) => f.name === fund) || null,
    [fundsInfo, fund]
  )

  if (!open) return null

  const body = () => ({
    ticker,
    direction,
    fund,
    notionalUsd: notional === '' ? undefined : Number(notional),
    rationale: rationale || undefined,
    origin,
  })

  const runPreview = async () => {
    setBusy(true)
    setError(null)
    setPreview(null)
    setResult(null)
    try {
      saveLastFund(fund)
      setPreview(await api.investPreview(body()))
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const runConfirm = async () => {
    setBusy(true)
    setError(null)
    try {
      saveLastFund(fund)
      setResult(await api.investConfirm(body()))
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const outcome = result?.outcomes?.[0]

  return (
    <div style={backdrop} onClick={onClose} role="presentation">
      <div style={panel} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' }}>
          <h3 style={{ margin: 0 }}>Invest {ticker}</h3>
          <button type="button" onClick={onClose}>Close</button>
        </div>
        <p style={{ color: 'var(--color-text-muted)', marginTop: 6 }}>
          Manual trade through the same risk checks as live signals.
          {fundsInfo?.tradingMode ? ` Mode: ${fundsInfo.tradingMode}.` : ''}
        </p>

        <div style={formGrid}>
          <label style={fieldLabel}>
            Fund
            <select value={fund} onChange={(e) => { setFund(e.target.value); setPreview(null) }}>
              {(fundsInfo?.funds || []).map((f) => (
                <option key={f.name} value={f.name}>
                  {f.name}{f.paper ? ' (paper)' : ' (live)'}
                </option>
              ))}
            </select>
          </label>
          <label style={fieldLabel}>
            Direction
            <select value={direction} onChange={(e) => { setDirection(e.target.value); setPreview(null) }}>
              <option value="buy">buy</option>
              <option value="sell">sell</option>
            </select>
          </label>
          <label style={fieldLabel}>
            Notional $
            <input
              type="number"
              min="1"
              step="1"
              value={notional}
              placeholder={selectedFund ? String(selectedFund.maxTradeNotionalUsd) : ''}
              onChange={(e) => { setNotional(e.target.value); setPreview(null) }}
            />
          </label>
        </div>
        {selectedFund && (
          <p style={{ color: 'var(--color-text-muted)', fontSize: 13 }}>
            Fund cap ${selectedFund.maxTradeNotionalUsd} / {selectedFund.maxTradePctEquity}% equity.
            Requested size is capped by risk limits.
          </p>
        )}

        {error && <p style={{ color: 'var(--color-bearish)' }}>{error}</p>}

        {!result && (
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button type="button" onClick={runPreview} disabled={busy || !fund || !ticker}>
              {busy && !preview ? 'Checking…' : 'Preview risk checks'}
            </button>
            {preview?.approved && (
              <button type="button" onClick={runConfirm} disabled={busy} style={{ borderColor: 'var(--color-bullish)' }}>
                {busy ? 'Submitting…' : `Confirm ${direction} $${Number(preview.notionalUsd).toFixed(2)}`}
              </button>
            )}
          </div>
        )}

        {preview && !result && (
          <div style={previewBox}>
            <strong style={{ color: preview.approved ? 'var(--color-bullish)' : 'var(--color-bearish)' }}>
              {preview.approved ? 'Would approve' : 'Would reject'}
            </strong>
            <div style={{ color: 'var(--color-text-muted)', marginTop: 4 }}>{preview.reason}</div>
            {preview.notionalUsd != null && (
              <div style={{ marginTop: 4 }}>Sized notional: ${Number(preview.notionalUsd).toFixed(2)}</div>
            )}
            <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 13 }}>
              {(preview.checks || []).map((c) => (
                <li key={c.check} style={{ color: c.pass ? 'var(--color-text)' : 'var(--color-bearish)' }}>
                  {c.check}: {c.detail}
                </li>
              ))}
            </ul>
          </div>
        )}

        {outcome && (
          <div style={previewBox}>
            <strong style={{ color: outcome.approved ? 'var(--color-bullish)' : 'var(--color-bearish)' }}>
              {outcome.approved
                ? (outcome.simulated ? 'Simulated order recorded' : 'Order submitted')
                : 'Rejected'}
            </strong>
            <div style={{ marginTop: 4 }}>
              {outcome.reason || `${outcome.direction || direction} ${ticker}`}
              {outcome.notionalUsd != null ? ` · $${Number(outcome.notionalUsd).toFixed(2)}` : ''}
              {outcome.signalId != null ? ` · signal #${outcome.signalId}` : ''}
            </div>
            <button type="button" onClick={onClose} style={{ marginTop: 10 }}>Done</button>
          </div>
        )}
      </div>
    </div>
  )
}

const backdrop = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.55)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
  padding: 16,
}

const panel = {
  background: 'var(--color-bg-panel)',
  border: '1px solid var(--color-border-subtle)',
  borderRadius: 8,
  padding: 16,
  width: 'min(520px, 100%)',
  maxHeight: '90vh',
  overflow: 'auto',
}

const formGrid = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr 1fr',
  gap: 10,
  marginTop: 12,
}

const fieldLabel = {
  display: 'grid',
  gap: 4,
  fontSize: 13,
  color: 'var(--color-text-muted)',
}

const previewBox = {
  marginTop: 12,
  padding: 12,
  borderRadius: 6,
  background: 'var(--color-overlay-panel)',
  border: '1px solid var(--color-border-subtle)',
}
