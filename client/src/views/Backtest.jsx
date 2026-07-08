import { useEffect, useState } from 'react'
import {
  LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer, ReferenceLine, Legend,
} from 'recharts'
import { api } from '../api.js'

export default function Backtest() {
  const [kind, setKind] = useState('congress')
  const [politicians, setPoliticians] = useState([])
  const [history, setHistory] = useState([])
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  // congress form
  const [politician, setPolitician] = useState('')
  const [exitRule, setExitRule] = useState('follow')
  const [minTrades, setMinTrades] = useState(3)
  // tweet form
  const [holdValue, setHoldValue] = useState(1)
  const [holdUnit, setHoldUnit] = useState('days')
  const [maxPosts, setMaxPosts] = useState(100)
  const [threshold, setThreshold] = useState(0.8)
  // shared
  const [startDate, setStartDate] = useState('2024-01-01')
  const [endDate, setEndDate] = useState(new Date().toISOString().slice(0, 10))
  const [notional, setNotional] = useState(1000)
  const [stopLoss, setStopLoss] = useState('')
  const [takeProfit, setTakeProfit] = useState('')

  useEffect(() => {
    api.politicians().then((p) => {
      setPoliticians(p)
      if (p.length && !politician) setPolitician(p[0].name)
    }).catch((e) => setError(`Could not load politician list: ${e.message}`))
    api.backtests().then(setHistory).catch(() => {})
  }, [])

  const run = async () => {
    setRunning(true)
    setError(null)
    setResult(null)
    try {
      const body = {
        startDate, endDate, notionalPerTrade: notional,
        stopLossPct: stopLoss !== '' ? Number(stopLoss) : undefined,
        takeProfitPct: takeProfit !== '' ? Number(takeProfit) : undefined,
      }
      let res
      if (kind === 'congress') {
        res = await api.runCongressBacktest({ ...body, politician, exitRule })
      } else if (kind === 'leaderboard') {
        res = await api.runLeaderboard({ startDate, endDate, notionalPerTrade: notional, exitRule, minTrades })
      } else {
        res = await api.runTweetBacktest({
          ...body,
          holdDays: holdUnit === 'days' ? holdValue : undefined,
          holdHours: holdUnit === 'hours' ? holdValue : undefined,
          maxPosts,
          confidenceThreshold: threshold,
        })
      }
      setResult(res)
      api.backtests().then(setHistory).catch(() => {})
    } catch (e) {
      setError(e.message)
    } finally {
      setRunning(false)
    }
  }

  const loadPast = async (id) => {
    setError(null)
    setResult(await api.backtest(id))
  }

  const runFullFor = (name) => {
    setKind('congress')
    setPolitician(name)
    setResult(null)
  }

  return (
    <div>
      <section style={card}>
        <h3>Run a Backtest</h3>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Field label="Strategy">
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="congress">Copy a politician</option>
              <option value="leaderboard">All-politicians leaderboard</option>
              <option value="tweet">Trump post sentiment</option>
            </select>
          </Field>

          {kind === 'congress' && (
            <Field label="Politician">
              <select value={politician} onChange={(e) => setPolitician(e.target.value)} style={{ maxWidth: 260 }}>
                {politicians.map((p) => (
                  <option key={p.name} value={p.name}>{p.name} ({p.tradeCount})</option>
                ))}
              </select>
            </Field>
          )}

          {(kind === 'congress' || kind === 'leaderboard') && (
            <Field label="Exit rule">
              <select value={exitRule} onChange={(e) => setExitRule(e.target.value)}>
                <option value="follow">Follow their sells</option>
                <option value="hold_30">Hold 30 days</option>
                <option value="hold_90">Hold 90 days</option>
                <option value="hold_to_present">Hold to present</option>
              </select>
            </Field>
          )}

          {kind === 'leaderboard' && (
            <Field label="Min trades">
              <input type="number" value={minTrades} min={1} onChange={(e) => setMinTrades(Number(e.target.value))} style={{ width: 60 }} />
            </Field>
          )}

          {kind === 'tweet' && (
            <>
              <Field label="Hold for">
                <div style={{ display: 'flex', gap: 4 }}>
                  <input type="number" value={holdValue} min={1} onChange={(e) => setHoldValue(Number(e.target.value))} style={{ width: 60 }} />
                  <select value={holdUnit} onChange={(e) => setHoldUnit(e.target.value)}>
                    <option value="days">days</option>
                    <option value="hours">hours</option>
                  </select>
                </div>
              </Field>
              <Field label="Max posts (LLM calls)">
                <input type="number" value={maxPosts} min={1} max={1000} onChange={(e) => setMaxPosts(Number(e.target.value))} style={{ width: 80 }} />
              </Field>
              <Field label="Confidence ≥">
                <input type="number" value={threshold} min={0} max={1} step={0.05} onChange={(e) => setThreshold(Number(e.target.value))} style={{ width: 70 }} />
              </Field>
            </>
          )}

          <Field label="From">
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </Field>
          <Field label="To">
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </Field>
          <Field label="$ per trade">
            <input type="number" value={notional} min={1} onChange={(e) => setNotional(Number(e.target.value))} style={{ width: 90 }} />
          </Field>

          {kind !== 'leaderboard' && (
            <>
              <Field label="Stop-loss %">
                <input type="number" value={stopLoss} min={0} placeholder="off" onChange={(e) => setStopLoss(e.target.value)} style={{ width: 65 }} />
              </Field>
              <Field label="Take-profit %">
                <input type="number" value={takeProfit} min={0} placeholder="off" onChange={(e) => setTakeProfit(e.target.value)} style={{ width: 65 }} />
              </Field>
            </>
          )}

          <button onClick={run} disabled={running} style={{ borderColor: '#6366f1' }}>
            {running ? 'Running…' : 'Run backtest'}
          </button>
        </div>
        {kind === 'tweet' && (
          <p style={{ color: '#a1a1aa', fontSize: '0.8em' }}>
            Each post is classified with a Claude API call — the post cap keeps cost bounded.
            Hours mode simulates on minute bars (falls back to daily when unavailable).
          </p>
        )}
        {kind === 'leaderboard' && (
          <p style={{ color: '#a1a1aa', fontSize: '0.8em' }}>
            Backtests every politician with ≥ min trades in the period and ranks them by return. Can take a while — one price series per traded ticker.
          </p>
        )}
        {error && <p style={{ color: '#fca5a5' }}>{error}</p>}
      </section>

      {result && (result.results.leaderboard
        ? <LeaderboardResults result={result} onPick={runFullFor} />
        : <Results result={result} />)}

      {history.length > 0 && (
        <section style={{ ...card, marginTop: 24 }}>
          <h3>Past Backtests</h3>
          <table>
            <thead><tr><th>ID</th><th>Kind</th><th>Params</th><th>When</th><th /></tr></thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id}>
                  <td>{h.id}</td>
                  <td>{h.kind}</td>
                  <td style={{ color: '#a1a1aa', maxWidth: 480 }}>{describeParams(h)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{h.created_at}</td>
                  <td><button onClick={() => loadPast(h.id)}>View</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  )
}

function describeParams(h) {
  const p = h.params
  const slTp = (p.stopLossPct || p.takeProfitPct)
    ? `, SL ${p.stopLossPct ?? '—'}%/TP ${p.takeProfitPct ?? '—'}%` : ''
  if (h.kind === 'congress') {
    return `${p.politician}, ${p.startDate}→${p.endDate}, $${p.notionalPerTrade}/trade, exit=${p.exitRule}${slTp}`
  }
  if (h.kind === 'leaderboard') {
    return `${p.startDate}→${p.endDate}, $${p.notionalPerTrade}/trade, exit=${p.exitRule}, min ${p.minTrades} trades`
  }
  const hold = p.holdHours ? `hold ${p.holdHours}h` : `hold ${p.holdDays}d`
  return `${p.startDate}→${p.endDate}, $${p.notionalPerTrade}/trade, ${hold}, conf ≥ ${p.confidenceThreshold}${slTp}`
}

function LeaderboardResults({ result, onPick }) {
  const { leaderboard, politiciansConsidered } = result.results
  return (
    <section style={{ ...card, marginTop: 24 }}>
      <h3>Leaderboard — {leaderboard.length} of {politiciansConsidered} politicians qualified</h3>
      <p style={{ color: '#a1a1aa', fontSize: '0.85em' }}>
        Ranked by return on deployed capital. Copying past winners does not guarantee future results.
      </p>
      <table>
        <thead>
          <tr><th>#</th><th>Politician</th><th>Trades</th><th>Win rate</th><th>P&L</th><th>Return</th><th /></tr>
        </thead>
        <tbody>
          {leaderboard.map((r, i) => (
            <tr key={r.politician}>
              <td>{i + 1}</td>
              <td>{r.politician}</td>
              <td>{r.trades}{r.skipped > 0 ? ` (+${r.skipped} skipped)` : ''}</td>
              <td>{r.winRate}%</td>
              <td style={{ color: r.totalPnl < 0 ? '#fca5a5' : '#86efac' }}>
                {r.totalPnl >= 0 ? '+' : ''}${r.totalPnl.toLocaleString()}
              </td>
              <td style={{ color: r.returnPct < 0 ? '#fca5a5' : '#86efac' }}>
                {r.returnPct >= 0 ? '+' : ''}{r.returnPct}%
              </td>
              <td><button onClick={() => onPick(r.politician)}>Full backtest</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

function Results({ result }) {
  const { summary, curve, trades, warning, classifications, benchmark } = result.results
  const r = result.results

  // Merge strategy + benchmark curves into one dataset for the chart
  const chartData = (() => {
    if (!benchmark?.curve?.length) return curve.map((p) => ({ date: p.date, strategy: p.cumulativePnl }))
    const dates = [...new Set([...curve.map((p) => p.date), ...benchmark.curve.map((p) => p.date)])].sort()
    const lastAt = (pts, d) => {
      const upTo = pts.filter((p) => p.date <= d)
      return upTo.length ? upTo[upTo.length - 1].cumulativePnl : null
    }
    return dates.map((d) => ({ date: d, strategy: lastAt(curve, d), spy: lastAt(benchmark.curve, d) }))
  })()

  return (
    <section style={{ ...card, marginTop: 24 }}>
      {warning && (
        <p style={{ background: '#7f1d1d', borderRadius: 6, padding: '8px 12px' }}>⚠️ {warning}</p>
      )}
      <h3>
        Result: {summary.totalPnl >= 0 ? '+' : ''}${summary.totalPnl.toLocaleString()}
        {' '}({summary.returnPct >= 0 ? '+' : ''}{summary.returnPct}% on ${summary.totalInvested.toLocaleString()} deployed)
        {benchmark && (
          <span style={{ fontSize: '0.75em', color: '#a1a1aa', fontWeight: 400 }}>
            {' '}vs SPY {benchmark.returnPct >= 0 ? '+' : ''}{benchmark.returnPct}%
            {' '}({summary.returnPct >= benchmark.returnPct ? 'beat' : 'trailed'} the market)
          </span>
        )}
      </h3>
      <p style={{ color: '#a1a1aa' }}>
        {summary.totalTrades} trades · {summary.wins}W/{summary.losses}L · {summary.winRate}% win rate
        {summary.skipped > 0 && ` · ${summary.skipped} skipped (no price data)`}
        {r.postsScanned != null &&
          ` · sampled ${r.postsScanned} of ${r.postsInRange ?? r.postsScanned} posts in range: ` +
          `${r.noImpactPosts ?? '?'} no market impact, ${r.belowThresholdTickers ?? '?'} ticker calls below threshold`}
        {r.fellBackToDaily > 0 && ` · ${r.fellBackToDaily} trades fell back to daily bars (no minute data)`}
      </p>

      {chartData.length > 1 && (
        <div style={{ height: 280 }}>
          <ResponsiveContainer>
            <LineChart data={chartData}>
              <CartesianGrid stroke="#26282f" />
              <XAxis dataKey="date" stroke="#a1a1aa" fontSize={11} />
              <YAxis stroke="#a1a1aa" fontSize={11} tickFormatter={(v) => `$${v}`} />
              <Tooltip
                contentStyle={{ background: '#1f2229', border: '1px solid #3f3f46' }}
                formatter={(v, name) => [`$${v}`, name === 'spy' ? 'SPY (same $)' : 'Strategy']}
              />
              {benchmark && <Legend formatter={(v) => (v === 'spy' ? 'SPY (same $)' : 'Strategy')} />}
              <ReferenceLine y={0} stroke="#52525b" />
              <Line type="monotone" dataKey="strategy" stroke="#6366f1" dot={false} strokeWidth={2} connectNulls />
              {benchmark && <Line type="monotone" dataKey="spy" stroke="#eab308" dot={false} strokeWidth={2} strokeDasharray="6 3" connectNulls />}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      <details style={{ marginTop: 12 }}>
        <summary style={{ cursor: 'pointer' }}>Per-trade breakdown ({trades.length})</summary>
        <table style={{ marginTop: 8 }}>
          <thead>
            <tr><th>Ticker</th><th>Entry</th><th>Exit</th><th>Entry $</th><th>Exit $</th><th>P&L</th><th>Exit via</th><th>Detail</th></tr>
          </thead>
          <tbody>
            {trades.map((t, i) => (
              <tr key={i} style={t.skipped ? { opacity: 0.5 } : {}}>
                <td>{t.ticker}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{String(t.entryDate).slice(0, 16).replace('T', ' ')}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{t.skipped ? '—' : String(t.exitDate).slice(0, 16).replace('T', ' ')}</td>
                <td>{t.skipped ? '—' : t.entryPrice?.toFixed(2)}</td>
                <td>{t.skipped ? '—' : t.exitPrice?.toFixed(2)}</td>
                <td style={{ color: t.pnl < 0 ? '#fca5a5' : '#86efac' }}>
                  {t.skipped ? t.skipReason : `${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}`}
                </td>
                <td>{t.skipped ? '—' : (t.exitReason || 'time')}{t.fellBackToDaily ? ' (daily)' : ''}</td>
                <td style={{ maxWidth: 340, color: '#a1a1aa', fontSize: '0.9em' }}>{t.label}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      {classifications?.length > 0 && (
        <details style={{ marginTop: 12 }}>
          <summary style={{ cursor: 'pointer' }}>
            What the classifier said, post by post ({classifications.length})
          </summary>
          <table style={{ marginTop: 8 }}>
            <thead>
              <tr><th>Posted</th><th>Post</th><th>Ticker calls</th><th>Reasoning</th></tr>
            </thead>
            <tbody>
              {classifications.map((c) => (
                <tr key={c.postId}>
                  <td style={{ whiteSpace: 'nowrap' }}>{c.createdAt.slice(0, 16).replace('T', ' ')}</td>
                  <td style={{ maxWidth: 320, color: '#a1a1aa', fontSize: '0.9em' }}>{c.text}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {c.tickers.length === 0
                      ? <span style={{ color: '#52525b' }}>no impact</span>
                      : c.tickers.map((t, i) => (
                          <div key={i} style={{ color: t.traded ? '#86efac' : '#eab308' }}>
                            {t.direction} {t.ticker} @ {t.confidence}{t.traded ? '' : ' (below threshold)'}
                          </div>
                        ))}
                  </td>
                  <td style={{ maxWidth: 300, color: '#a1a1aa', fontSize: '0.9em' }}>{c.rationale}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </section>
  )
}

function Field({ label, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: '0.8em', color: '#a1a1aa' }}>
      {label}
      {children}
    </label>
  )
}

const card = {
  background: '#16181d',
  border: '1px solid #26282f',
  borderRadius: 10,
  padding: '16px 20px',
}
