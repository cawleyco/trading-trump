import { useEffect, useState } from 'react'
import { api } from '../api.js'

export default function StatusBar() {
  const [status, setStatus] = useState(null)
  const [posture, setPosture] = useState({})
  const [error, setError] = useState(null)

  const refresh = () => {
    api.status().then((s) => { setStatus(s); setError(null) }).catch((e) => setError(e.message))
    api.posture()
      .then((p) => setPosture(Object.fromEntries((p.funds || []).map((f) => [f.name, f]))))
      .catch(() => {})
  }

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 10000)
    return () => clearInterval(t)
  }, [])

  if (error) {
    return <div style={bar('rgba(224, 90, 90, 0.16)')}>Cannot reach bot server: {error}</div>
  }
  if (!status) return <div style={bar('var(--color-bg-elevated)')}>Loading status...</div>

  const live = status.tradingMode === 'live'

  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ ...bar(live ? 'rgba(249, 115, 22, 0.14)' : 'rgba(56, 193, 114, 0.12)'), marginTop: 0 }}>
        <strong>{live ? 'LIVE MODE' : 'DRY RUN'}</strong>
        {status.globallyHalted && <strong style={{ color: 'var(--color-bearish)' }}> - GLOBAL HALT FILE PRESENT</strong>}
        <span style={{ flex: 1 }} />
        <span style={{ color: 'var(--color-text-muted)', fontSize: '0.85em' }}>
          {status.funds.length} fund{status.funds.length === 1 ? '' : 's'}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8 }}>
        {status.funds.map((f) => <FundChip key={f.name} fund={f} posture={posture[f.name]} live={live} onChange={refresh} />)}
      </div>
    </div>
  )
}

function autoLabel(posture) {
  if (!posture) return null
  if (posture.autoStrategiesEffective) return 'auto: ON'
  if (posture.allowAutoStrategies) return 'auto: opted-in (needs live)'
  return 'auto: off'
}

function FundChip({ fund, posture, live, onChange }) {
  const onHalt = async () => {
    if (!confirm(`Halt fund "${fund.name}"? Its open orders will be cancelled.`)) return
    await api.halt('dashboard fund chip', fund.name)
    onChange()
  }
  const onResume = async () => {
    if (!confirm(`Resume fund "${fund.name}"? Only do this after reviewing why it halted.`)) return
    await api.resume(fund.name)
    onChange()
  }

  const dayPnl = fund.dailyPnl ? fund.dailyPnl.realized_pnl + fund.dailyPnl.unrealized_pnl : 0
  const bg = fund.halted
    ? 'rgba(224, 90, 90, 0.16)'
    : fund.error
      ? 'rgba(245, 177, 76, 0.14)'
      : !fund.paper && live
        ? 'rgba(249, 115, 22, 0.14)'
        : 'var(--color-bg-panel)'

  return (
    <div style={{
      background: bg, border: '1px solid var(--color-border-subtle)', borderRadius: 8,
      padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 14, flex: 1, minWidth: 340,
    }}>
      <div>
        <div style={{ fontWeight: 600 }}>
          {fund.halted ? 'HALTED' : fund.paper ? 'PAPER' : 'LIVE'} {fund.name}
          <span style={{ color: 'var(--color-text-muted)', fontWeight: 400, fontSize: '0.8em' }}>
            {' '}· {fund.paper ? 'paper' : 'LIVE'} · {fund.sources.join('+')}
            {posture && <> · {autoLabel(posture)} · {posture.activeStrategies} strat</>}
          </span>
        </div>
        <div style={{ fontSize: '0.8em', color: 'var(--color-text-muted)' }}>
          {fund.error
            ? `Warning: ${fund.error}`
            : fund.halted
              ? fund.haltReason
              : <>
                  Equity ${fund.equity?.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  {' · '}
                  <span style={{ color: dayPnl < 0 ? 'var(--color-bearish)' : 'var(--color-bullish)' }}>
                    day {dayPnl >= 0 ? '+' : ''}{dayPnl.toFixed(2)}
                  </span>
                  {' · '}{fund.positions.length} positions
                </>}
        </div>
      </div>
      <span style={{ flex: 1 }} />
      {fund.halted
        ? <button onClick={onResume}>Reset & Resume</button>
        : <button onClick={onHalt} style={{ background: 'rgba(224, 90, 90, 0.18)', borderColor: 'var(--color-bearish)' }}>Halt</button>}
    </div>
  )
}

function bar(bg) {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    background: bg,
    border: '1px solid var(--color-border-subtle)',
    borderRadius: 8,
    padding: '10px 16px',
    marginTop: 16,
    fontSize: '0.95em',
  }
}
