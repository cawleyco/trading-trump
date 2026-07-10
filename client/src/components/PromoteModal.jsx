import { useEffect, useState } from 'react'
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

/**
 * Promote a congress/strategy backtest into a live strategy.
 * Always asks for mode + fund; defaults mode to manual.
 */
export default function PromoteModal({
  open,
  onClose,
  from,
  defaultName = '',
  defaultNotional = 500,
}) {
  const [fundsInfo, setFundsInfo] = useState(null)
  const [name, setName] = useState(defaultName)
  const [mode, setMode] = useState('manual')
  const [fund, setFund] = useState('')
  const [notional, setNotional] = useState(defaultNotional)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setName(defaultName)
    setMode('manual')
    setNotional(defaultNotional)
    setError(null)
    setResult(null)
    api.investFunds()
      .then((info) => {
        setFundsInfo(info)
        const last = loadLastFund()
        const funds = info.funds || []
        const pick = (last && funds.some((f) => f.name === last))
          ? last
          : (funds.find((f) => f.paper)?.name || funds[0]?.name || '')
        setFund(pick)
      })
      .catch((e) => setError(e.message))
  }, [open, defaultName, defaultNotional])

  if (!open) return null

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      saveLastFund(fund)
      setResult(await api.promoteStrategy({
        name: name.trim() || undefined,
        mode,
        fund,
        notionalUsd: Number(notional),
        from,
      }))
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={backdrop} onClick={onClose} role="presentation">
      <div style={panel} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' }}>
          <h3 style={{ margin: 0 }}>Promote to strategy</h3>
          <button type="button" onClick={onClose}>Close</button>
        </div>
        <p style={{ color: 'var(--color-text-muted)' }}>
          Creates a congress strategy from this backtest. Default mode is manual approval.
        </p>

        <div style={formGrid}>
          <label style={{ gridColumn: '1 / -1' }}>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Strategy name" />
          </label>
          <label>
            Mode
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="watch">watch</option>
              <option value="manual">manual</option>
              <option value="paper">paper</option>
              <option value="auto">auto</option>
            </select>
          </label>
          <label>
            Fund
            <select value={fund} onChange={(e) => setFund(e.target.value)}>
              {(fundsInfo?.funds || []).map((f) => (
                <option key={f.name} value={f.name}>
                  {f.name}{f.paper ? ' (paper)' : ' (live)'}
                </option>
              ))}
            </select>
          </label>
          <label>
            Notional $
            <input type="number" min="1" value={notional} onChange={(e) => setNotional(e.target.value)} />
          </label>
        </div>

        {fundsInfo?.signalRouting && fundsInfo.signalRouting !== 'strategies' && (
          <p style={{ color: 'var(--color-bearish)', fontSize: 13 }}>
            SIGNAL_ROUTING is &quot;{fundsInfo.signalRouting}&quot;. Promoted strategies will not receive live
            congress trades until you set SIGNAL_ROUTING=strategies and restart.
          </p>
        )}

        {error && <p style={{ color: 'var(--color-bearish)' }}>{error}</p>}

        {!result ? (
          <button type="button" onClick={submit} disabled={busy || !fund} style={{ marginTop: 8 }}>
            {busy ? 'Creating…' : 'Create strategy'}
          </button>
        ) : (
          <div style={previewBox}>
            <strong style={{ color: 'var(--color-bullish)' }}>
              Created strategy #{result.strategy.id}: {result.strategy.name}
            </strong>
            {result.routingWarning && (
              <p style={{ color: 'var(--color-bearish)', marginBottom: 0 }}>{result.routingWarning}</p>
            )}
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

const previewBox = {
  marginTop: 12,
  padding: 12,
  borderRadius: 6,
  background: 'var(--color-overlay-panel)',
  border: '1px solid var(--color-border-subtle)',
}
