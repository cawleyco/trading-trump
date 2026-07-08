import { useEffect, useState } from 'react'
import { api } from '../api.js'

export default function StatusBar() {
  const [status, setStatus] = useState(null)
  const [error, setError] = useState(null)

  const refresh = () => {
    api.status().then((s) => { setStatus(s); setError(null) }).catch((e) => setError(e.message))
  }

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 10000)
    return () => clearInterval(t)
  }, [])

  if (error) {
    return <div style={bar('#7f1d1d')}>Cannot reach bot server: {error}</div>
  }
  if (!status) return <div style={bar('#1f2229')}>Loading status…</div>

  const live = status.tradingMode === 'live'

  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ ...bar(live ? '#713f12' : '#14532d'), marginTop: 0 }}>
        <strong>{live ? '🔴 LIVE MODE' : '🟢 DRY RUN'}</strong>
        {status.globallyHalted && <strong style={{ color: '#fca5a5' }}> — GLOBAL HALT FILE PRESENT</strong>}
        <span style={{ flex: 1 }} />
        <span style={{ color: '#a1a1aa', fontSize: '0.85em' }}>
          {status.funds.length} fund{status.funds.length === 1 ? '' : 's'}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8 }}>
        {status.funds.map((f) => <FundChip key={f.name} fund={f} live={live} onChange={refresh} />)}
      </div>
    </div>
  )
}

function FundChip({ fund, live, onChange }) {
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
  const bg = fund.halted ? '#7f1d1d' : fund.error ? '#78350f' : !fund.paper && live ? '#713f12' : '#1f2229'

  return (
    <div style={{
      background: bg, border: '1px solid #3f3f46', borderRadius: 8,
      padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 14, flex: 1, minWidth: 340,
    }}>
      <div>
        <div style={{ fontWeight: 600 }}>
          {fund.halted ? '⛔' : fund.paper ? '🧪' : '💵'} {fund.name}
          <span style={{ color: '#a1a1aa', fontWeight: 400, fontSize: '0.8em' }}>
            {' '}· {fund.paper ? 'paper' : 'LIVE'} · {fund.sources.join('+')}
          </span>
        </div>
        <div style={{ fontSize: '0.8em', color: '#a1a1aa' }}>
          {fund.error
            ? `⚠ ${fund.error}`
            : fund.halted
              ? fund.haltReason
              : <>
                  Equity ${fund.equity?.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  {' · '}
                  <span style={{ color: dayPnl < 0 ? '#fca5a5' : '#86efac' }}>
                    day {dayPnl >= 0 ? '+' : ''}{dayPnl.toFixed(2)}
                  </span>
                  {' · '}{fund.positions.length} positions
                </>}
        </div>
      </div>
      <span style={{ flex: 1 }} />
      {fund.halted
        ? <button onClick={onResume}>Reset & Resume</button>
        : <button onClick={onHalt} style={{ background: '#7f1d1d', borderColor: '#b91c1c' }}>KILL</button>}
    </div>
  )
}

function bar(bg) {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    background: bg,
    borderRadius: 8,
    padding: '10px 16px',
    marginTop: 16,
    fontSize: '0.95em',
  }
}
