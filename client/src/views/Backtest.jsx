import { useEffect, useState } from 'react'
import {
  LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer, ReferenceLine, Legend,
} from 'recharts'
import { api } from '../api.js'

export default function Backtest() {
  const [kind, setKind] = useState('congress')
  const [politicians, setPoliticians] = useState([])
  const [history, setHistory] = useState([])
  const [presets, setPresets] = useState([])
  const [running, setRunning] = useState(false)
  const [savingPreset, setSavingPreset] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [presetName, setPresetName] = useState('')

  // congress form
  const [politician, setPolitician] = useState('')
  const [exitRule, setExitRule] = useState('follow')
  const [entryBasis, setEntryBasis] = useState('disclosure')
  const [minTrades, setMinTrades] = useState(3)
  const [folds, setFolds] = useState(4)
  const [topN, setTopN] = useState(5)
  const [compare, setCompare] = useState(null)
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
      if (p.length) setPolitician((current) => current || p[0].name)
    }).catch((e) => setError(`Could not load politician list: ${e.message}`))
    api.backtests().then(setHistory).catch(() => {})
    api.backtestPresets().then(setPresets).catch(() => {})
  }, [])

  const currentParams = () => ({
    politician,
    exitRule,
    entryBasis,
    minTrades,
    folds,
    topN,
    holdValue,
    holdUnit,
    maxPosts,
    threshold,
    startDate,
    endDate,
    notional,
    stopLoss,
    takeProfit,
  })

  const applyPreset = (preset) => {
    const p = preset.params || {}
    setKind(preset.kind)
    if (p.politician != null) setPolitician(p.politician)
    if (p.exitRule != null) setExitRule(p.exitRule)
    if (p.entryBasis != null) setEntryBasis(p.entryBasis)
    if (p.minTrades != null) setMinTrades(Number(p.minTrades))
    if (p.folds != null) setFolds(Number(p.folds))
    if (p.topN != null) setTopN(Number(p.topN))
    if (p.holdValue != null) setHoldValue(Number(p.holdValue))
    if (p.holdUnit != null) setHoldUnit(p.holdUnit)
    if (p.maxPosts != null) setMaxPosts(Number(p.maxPosts))
    if (p.threshold != null) setThreshold(Number(p.threshold))
    if (p.startDate != null) setStartDate(p.startDate)
    if (p.endDate != null) setEndDate(p.endDate)
    if (p.notional != null) setNotional(Number(p.notional))
    if (p.stopLoss != null) setStopLoss(p.stopLoss)
    if (p.takeProfit != null) setTakeProfit(p.takeProfit)
    setPresetName(preset.name)
    setResult(null)
    setCompare(null)
  }

  const savePreset = async () => {
    const name = presetName.trim()
    if (!name) {
      setError('Name the preset before saving it.')
      return
    }
    setSavingPreset(true)
    setError(null)
    try {
      const existing = presets.find((p) => p.name.toLowerCase() === name.toLowerCase())
      const body = { name, kind, params: currentParams() }
      if (existing) {
        await api.updateBacktestPreset(existing.id, body)
      } else {
        await api.createBacktestPreset(body)
      }
      setPresets(await api.backtestPresets())
    } catch (e) {
      setError(e.message)
    } finally {
      setSavingPreset(false)
    }
  }

  const removePreset = async (id) => {
    setError(null)
    try {
      await api.deleteBacktestPreset(id)
      setPresets(await api.backtestPresets())
    } catch (e) {
      setError(e.message)
    }
  }

  const run = async () => {
    setRunning(true)
    setError(null)
    setResult(null)
    setCompare(null)
    try {
      const body = {
        startDate, endDate, notionalPerTrade: notional,
        stopLossPct: stopLoss !== '' ? Number(stopLoss) : undefined,
        takeProfitPct: takeProfit !== '' ? Number(takeProfit) : undefined,
      }
      let res
      if (kind === 'congress') {
        res = await api.runCongressBacktest({ ...body, politician, exitRule, entryBasis })
      } else if (kind === 'leaderboard') {
        res = await api.runLeaderboard({ startDate, endDate, notionalPerTrade: notional, exitRule, minTrades, entryBasis })
      } else if (kind === 'walk-forward') {
        res = await api.runWalkForward({ startDate, endDate, notionalPerTrade: notional, exitRule, minTrades, entryBasis, folds, topN })
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
    setCompare(null)
    setResult(await api.backtest(id))
  }

  const runCompare = async () => {
    setRunning(true)
    setError(null)
    setResult(null)
    setCompare(null)
    try {
      setCompare(await api.compareEntryBasis({
        politician, startDate, endDate, notionalPerTrade: notional, exitRule,
        stopLossPct: stopLoss !== '' ? Number(stopLoss) : undefined,
        takeProfitPct: takeProfit !== '' ? Number(takeProfit) : undefined,
      }))
    } catch (e) {
      setError(e.message)
    } finally {
      setRunning(false)
    }
  }

  const runFullFor = (name) => {
    setKind('congress')
    setPolitician(name)
    setResult(null)
  }

  return (
    <div>
      <section style={card}>
        <h3>Research Presets</h3>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Field label="Load setup">
            <select value="" onChange={(e) => {
              const preset = presets.find((p) => String(p.id) === e.target.value)
              if (preset) applyPreset(preset)
            }} style={{ minWidth: 240 }}>
              <option value="">Choose a saved preset</option>
              {presets.map((p) => (
                <option key={p.id} value={p.id}>{p.name} · {labelKind(p.kind)}</option>
              ))}
            </select>
          </Field>
          <Field label="Preset name">
            <input value={presetName} onChange={(e) => setPresetName(e.target.value)} placeholder="e.g. Top 5 disclosure walk-forward" style={{ minWidth: 300 }} />
          </Field>
          <button onClick={savePreset} disabled={savingPreset}>
            {savingPreset ? 'Saving…' : 'Save current setup'}
          </button>
        </div>
        {presets.length > 0 && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
            {presets.slice(0, 8).map((p) => (
              <div key={p.id} style={presetPill}>
                <button onClick={() => applyPreset(p)} style={pillButton} title={describePreset(p)}>
                  {p.name}
                </button>
                <button onClick={() => removePreset(p.id)} style={deletePillButton} title={`Delete ${p.name}`}>×</button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section style={{ ...card, marginTop: 16 }}>
        <h3>Run a Backtest</h3>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Field label="Strategy">
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="congress">Copy a politician</option>
              <option value="leaderboard">All-politicians leaderboard</option>
              <option value="walk-forward">Walk-forward (overfitting guard)</option>
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

          {(kind === 'congress' || kind === 'leaderboard' || kind === 'walk-forward') && (
            <Field label="Exit rule">
              <select value={exitRule} onChange={(e) => setExitRule(e.target.value)}>
                <option value="follow">Follow their sells</option>
                <option value="hold_30">Hold 30 days</option>
                <option value="hold_90">Hold 90 days</option>
                <option value="hold_to_present">Hold to present</option>
              </select>
            </Field>
          )}

          {(kind === 'congress' || kind === 'leaderboard' || kind === 'walk-forward') && (
            <Field label="Entry basis">
              <select value={entryBasis} onChange={(e) => setEntryBasis(e.target.value)}>
                <option value="disclosure">Disclosure date (realistic)</option>
                <option value="transaction">Transaction date (fantasy)</option>
                <option value="first_seen">First seen (live copier)</option>
              </select>
            </Field>
          )}

          {(kind === 'leaderboard' || kind === 'walk-forward') && (
            <Field label="Min trades">
              <input type="number" value={minTrades} min={1} onChange={(e) => setMinTrades(Number(e.target.value))} style={{ width: 60 }} />
            </Field>
          )}

          {kind === 'walk-forward' && (
            <>
              <Field label="Folds">
                <input type="number" value={folds} min={2} max={12} onChange={(e) => setFolds(Number(e.target.value))} style={{ width: 60 }} />
              </Field>
              <Field label="Top N">
                <input type="number" value={topN} min={1} max={20} onChange={(e) => setTopN(Number(e.target.value))} style={{ width: 60 }} />
              </Field>
            </>
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

          {(kind === 'congress' || kind === 'tweet') && (
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
          {kind === 'congress' && (
            <button onClick={runCompare} disabled={running} title="Run transaction vs disclosure basis side by side">
              Compare modes
            </button>
          )}
        </div>
        {(kind === 'congress' || kind === 'leaderboard' || kind === 'walk-forward') && entryBasis === 'transaction' && (
          <p style={{ background: '#7f1d1d', borderRadius: 6, padding: '8px 12px', marginTop: 10 }}>
            ⚠️ Fantasy mode: assumes you knew on the trade date — not achievable. Upper bound only.
          </p>
        )}
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
        {kind === 'walk-forward' && (
          <p style={{ color: '#a1a1aa', fontSize: '0.8em' }}>
            Splits the range into folds, ranks politicians in each fold, then copies only that fold's top-N into the <em>next</em> fold — measuring out-of-sample return. High in-sample rank that flops out-of-sample is the overfitting tell.
          </p>
        )}
        {error && <p style={{ color: '#fca5a5' }}>{error}</p>}
      </section>

      {compare && <CompareResults compare={compare} />}

      {result && (
        result.results.kind === 'walk-forward' || result.results.foldResults
          ? <WalkForwardResults result={result} />
          : result.results.leaderboard
            ? <LeaderboardResults result={result} onPick={runFullFor} />
            : <Results result={result} />
      )}

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

function labelKind(kind) {
  if (kind === 'congress') return 'Politician copy'
  if (kind === 'leaderboard') return 'Leaderboard'
  if (kind === 'walk-forward') return 'Walk-forward'
  if (kind === 'tweet') return 'Post sentiment'
  return kind
}

function describePreset(preset) {
  const p = preset.params || {}
  if (preset.kind === 'congress') return `${p.politician || 'Politician'}, ${p.startDate || '?'} to ${p.endDate || '?'}, ${p.exitRule || 'exit'}`
  if (preset.kind === 'leaderboard') return `${p.startDate || '?'} to ${p.endDate || '?'}, min ${p.minTrades || '?'} trades`
  if (preset.kind === 'walk-forward') return `${p.folds || '?'} folds, top ${p.topN || '?'}, ${p.startDate || '?'} to ${p.endDate || '?'}`
  return `${p.startDate || '?'} to ${p.endDate || '?'}, confidence >= ${p.threshold ?? '?'}`
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
  if (h.kind === 'walk-forward') {
    return `${p.startDate}→${p.endDate}, ${p.folds} folds, top ${p.topN}, $${p.notionalPerTrade}/trade, exit=${p.exitRule}`
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

function WalkForwardResults({ result }) {
  const { foldResults, aggregate, folds, topN } = result.results
  const agg = aggregate?.summary
  const bench = aggregate?.benchmark
  const curve = aggregate?.curve || []
  const chartData = curve.map((p) => ({ date: p.date, oos: p.cumulativePnl }))
  const benchCurve = bench?.curve || []
  if (benchCurve.length) {
    const lastAt = (pts, d) => {
      const upTo = pts.filter((p) => p.date <= d)
      return upTo.length ? upTo[upTo.length - 1].cumulativePnl : null
    }
    for (const row of chartData) row.spy = lastAt(benchCurve, row.date)
  }

  return (
    <section style={{ ...card, marginTop: 24 }}>
      <h3>Walk-forward — {folds} folds, top {topN} copied out-of-sample</h3>
      {agg && (
        <h4 style={{ margin: '4px 0 12px', fontWeight: 500 }}>
          Aggregate out-of-sample:{' '}
          <span style={{ color: agg.returnPct < 0 ? '#fca5a5' : '#86efac' }}>
            {agg.returnPct >= 0 ? '+' : ''}{agg.returnPct}%
          </span>
          {bench && (
            <span style={{ fontSize: '0.8em', color: '#a1a1aa', fontWeight: 400 }}>
              {' '}vs SPY {bench.returnPct >= 0 ? '+' : ''}{bench.returnPct}%
              {' '}({agg.returnPct >= bench.returnPct ? 'beat' : 'trailed'} the market)
            </span>
          )}
        </h4>
      )}
      <p style={{ color: '#a1a1aa', fontSize: '0.85em' }}>
        Each fold ranks politicians in-sample, then copies only the top {topN} into the next (unseen) fold.
        Out-of-sample return is the honest estimate; a big drop from in-sample rank is overfitting.
      </p>
      {aggregate && <ResultQuality results={aggregate} label="Out-of-sample quality" />}
      <table>
        <thead>
          <tr><th>Fold</th><th>Train → Test window</th><th>Top politicians (in-sample)</th><th>OOS trades</th><th>OOS return</th><th>SPY</th></tr>
        </thead>
        <tbody>
          {foldResults.map((f) => (
            <tr key={f.fold}>
              <td>{f.fold}</td>
              <td style={{ whiteSpace: 'nowrap', fontSize: '0.85em' }}>
                {f.trainWindow.start}→{f.trainWindow.end} <span style={{ color: '#52525b' }}>then</span> {f.testWindow.start}→{f.testWindow.end}
              </td>
              <td style={{ maxWidth: 260, color: '#a1a1aa', fontSize: '0.85em' }}>
                {f.topPoliticians.length ? f.topPoliticians.join(', ') : <span style={{ color: '#52525b' }}>none qualified</span>}
              </td>
              <td>{f.outOfSample.totalTrades}</td>
              <td style={{ color: f.outOfSample.returnPct < 0 ? '#fca5a5' : '#86efac' }}>
                {f.outOfSample.returnPct >= 0 ? '+' : ''}{f.outOfSample.returnPct}%
              </td>
              <td style={{ color: '#a1a1aa' }}>{f.benchmark ? `${f.benchmark.returnPct >= 0 ? '+' : ''}${f.benchmark.returnPct}%` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {chartData.length > 1 && (
        <div style={{ height: 260, marginTop: 12 }}>
          <ResponsiveContainer>
            <LineChart data={chartData}>
              <CartesianGrid stroke="#26282f" />
              <XAxis dataKey="date" stroke="#a1a1aa" fontSize={11} />
              <YAxis stroke="#a1a1aa" fontSize={11} tickFormatter={(v) => `$${v}`} />
              <Tooltip
                contentStyle={{ background: '#1f2229', border: '1px solid #3f3f46' }}
                formatter={(v, name) => [`$${v}`, name === 'spy' ? 'SPY (same $)' : 'Out-of-sample']}
              />
              <Legend formatter={(v) => (v === 'spy' ? 'SPY (same $)' : 'Out-of-sample')} />
              <ReferenceLine y={0} stroke="#52525b" />
              <Line type="monotone" dataKey="oos" stroke="#6366f1" dot={false} strokeWidth={2} connectNulls />
              {benchCurve.length > 0 && <Line type="monotone" dataKey="spy" stroke="#eab308" dot={false} strokeWidth={2} strokeDasharray="6 3" connectNulls />}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  )
}

function CompareResults({ compare }) {
  const t = compare.transaction.results.summary
  const d = compare.disclosure.results.summary
  const row = (label, s, note) => (
    <tr>
      <td>{label}</td>
      <td>{s.totalTrades}</td>
      <td>{s.winRate}%</td>
      <td style={{ color: s.returnPct < 0 ? '#fca5a5' : '#86efac' }}>
        {s.returnPct >= 0 ? '+' : ''}{s.returnPct}%
      </td>
      <td style={{ color: '#a1a1aa', fontSize: '0.85em' }}>{note}</td>
    </tr>
  )
  return (
    <section style={{ ...card, marginTop: 24 }}>
      <h3>Fantasy vs realistic — the disclosure gap</h3>
      <p style={{ background: '#7f1d1d', borderRadius: 6, padding: '8px 12px' }}>
        ⚠️ Transaction basis assumes you knew on the trade date — not achievable. Upper bound only.
      </p>
      <table>
        <thead>
          <tr><th>Basis</th><th>Trades</th><th>Win rate</th><th>Return</th><th /></tr>
        </thead>
        <tbody>
          {row('Transaction (fantasy)', t, 'you cannot know before disclosure')}
          {row('Disclosure (realistic)', d, 'what a live copier could achieve')}
        </tbody>
      </table>
      <p style={{ marginTop: 8 }}>
        The disclosure lag costs <strong style={{ color: '#eab308' }}>{compare.gapPct >= 0 ? '' : '+'}{(-compare.gapPct).toFixed(2)} pts</strong> of return
        {' '}({t.returnPct}% → {d.returnPct}%).
      </p>
    </section>
  )
}

function Results({ result }) {
  const { summary, curve, trades, warning, classifications, benchmark, entryBasis } = result.results
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
      {entryBasis === 'transaction' && (
        <p style={{ background: '#7f1d1d', borderRadius: 6, padding: '8px 12px' }}>
          ⚠️ Fantasy mode (transaction-date entry): assumes you knew on the trade date — not achievable. Upper bound only.
        </p>
      )}
      {entryBasis && entryBasis !== 'transaction' && (
        <p style={{ color: '#a1a1aa', fontSize: '0.8em', margin: '0 0 4px' }}>Entry basis: {entryBasis}</p>
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
      <ResultQuality results={result.results} />

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
              <tr><th>Posted</th><th>Post</th><th>Relevance</th><th>Ticker calls</th><th>Reasoning</th></tr>
            </thead>
            <tbody>
              {classifications.map((c) => (
                <tr key={c.postId}>
                  <td style={{ whiteSpace: 'nowrap' }}>{c.createdAt.slice(0, 16).replace('T', ' ')}</td>
                  <td style={{ maxWidth: 320, color: '#a1a1aa', fontSize: '0.9em' }}>{c.text}</td>
                  <td style={{ whiteSpace: 'nowrap', color: c.marketRelevant ? '#86efac' : '#a1a1aa' }}>
                    <div>{c.relevanceType || '—'} @ {c.marketRelevance ?? '—'}</div>
                    {c.sectors?.length > 0 && <div style={{ color: '#a1a1aa', fontSize: '0.9em' }}>{c.sectors.join(', ')}</div>}
                  </td>
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

function ResultQuality({ results, label = 'Result quality' }) {
  const summary = results?.summary
  if (!summary) return null
  const trades = results.trades || []
  const executed = trades.filter((t) => !t.skipped)
  const biggest = executed.length
    ? executed.reduce((best, t) => Math.abs(t.pnl || 0) > Math.abs(best.pnl || 0) ? t : best, executed[0])
    : null
  const concentrationPct = biggest && summary.totalPnl
    ? Math.abs((biggest.pnl / summary.totalPnl) * 100)
    : null
  const hasCosts = executed.some((t) => (t.slippageBps || 0) > 0 || (t.feePerTradeUsd || 0) > 0)
  const benchmarkDelta = results.benchmark
    ? Number((summary.returnPct - results.benchmark.returnPct).toFixed(2))
    : null
  const checks = [
    {
      label: 'Sample',
      value: `${summary.totalTrades} trades`,
      tone: summary.totalTrades >= 30 ? 'good' : summary.totalTrades >= 10 ? 'warn' : 'bad',
      detail: summary.totalTrades >= 30 ? 'broad enough to start trusting' : summary.totalTrades >= 10 ? 'usable, but still thin' : 'too small for much confidence',
    },
    {
      label: 'Benchmark',
      value: results.benchmark ? `${benchmarkDelta >= 0 ? '+' : ''}${benchmarkDelta}% vs SPY` : 'not run',
      tone: results.benchmark ? (benchmarkDelta > 0 ? 'good' : 'bad') : 'warn',
      detail: results.benchmark ? (benchmarkDelta > 0 ? 'beat the market baseline' : 'trailed the market baseline') : 'no index comparison available',
    },
    {
      label: 'Data coverage',
      value: `${summary.skipped || 0} skipped`,
      tone: summary.skipped ? 'warn' : 'good',
      detail: summary.skipped ? 'some trades had no usable price data' : 'all planned trades had price data',
    },
    {
      label: 'Costs',
      value: hasCosts ? 'included' : 'not included',
      tone: hasCosts ? 'good' : 'warn',
      detail: hasCosts ? 'returns include slippage or fees' : 'results may be optimistic',
    },
    {
      label: 'Concentration',
      value: concentrationPct == null ? 'n/a' : `${Math.round(concentrationPct)}% biggest trade`,
      tone: concentrationPct == null ? 'warn' : concentrationPct <= 35 ? 'good' : concentrationPct <= 60 ? 'warn' : 'bad',
      detail: concentrationPct == null ? 'not enough profit dispersion to measure' : concentrationPct <= 35 ? 'not dominated by one trade' : 'one trade explains a large share of P&L',
    },
  ]

  return (
    <div style={qualityBox}>
      <div style={{ fontSize: '0.82em', color: '#a1a1aa', fontWeight: 700, marginBottom: 8 }}>{label}</div>
      <div style={qualityGrid}>
        {checks.map((c) => (
          <div key={c.label} style={{ ...qualityItem, borderColor: toneColor(c.tone, 0.45) }}>
            <div style={{ color: toneColor(c.tone), fontWeight: 750 }}>{c.value}</div>
            <div style={{ color: '#f3f4f6', fontSize: '0.78em', marginTop: 2 }}>{c.label}</div>
            <div style={{ color: '#a1a1aa', fontSize: '0.76em', marginTop: 3 }}>{c.detail}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

function toneColor(tone, alpha = 1) {
  const colors = {
    good: `rgba(134, 239, 172, ${alpha})`,
    warn: `rgba(234, 179, 8, ${alpha})`,
    bad: `rgba(252, 165, 165, ${alpha})`,
  }
  return colors[tone] || colors.warn
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
  borderRadius: 8,
  padding: '16px 20px',
}

const presetPill = {
  display: 'inline-flex',
  alignItems: 'stretch',
  border: '1px solid #344255',
  borderRadius: 6,
  overflow: 'hidden',
  background: '#111821',
}

const pillButton = {
  border: 0,
  borderRadius: 0,
  background: 'transparent',
  padding: '6px 9px',
}

const deletePillButton = {
  borderWidth: '0 0 0 1px',
  borderColor: '#344255',
  borderRadius: 0,
  background: 'transparent',
  padding: '6px 8px',
  color: '#a1a1aa',
}

const qualityBox = {
  border: '1px solid #26282f',
  borderRadius: 8,
  padding: 12,
  margin: '12px 0',
  background: '#111821',
}

const qualityGrid = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
  gap: 8,
}

const qualityItem = {
  border: '1px solid',
  borderRadius: 6,
  padding: 10,
  minHeight: 86,
  background: '#16181d',
}
