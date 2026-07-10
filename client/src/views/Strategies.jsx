import { useCallback, useEffect, useState } from 'react'
import { api } from '../api.js'
import { HelpLink } from '../components/intel/components.jsx'
import { PromoteButton } from '../components/InvestButton.jsx'

const emptyDefinition = {
  source: 'congress',
  filters: {
    direction: '',
    minCopyScore: '',
    minConfidence: '',
    maxDisclosureLagDays: '',
    maxDriftPct: '',
    minClusterCount: '',
    minRelevanceScore: '',
    politicians: '',
    excludePoliticians: '',
    sectors: '',
    excludeWarnings: '',
    minAmountMid: '',
    minEdgeScore: '',
  },
  action: { mode: 'watch', fund: 'paper', notionalUsd: 500 },
}

function fromDefinition(strategy) {
  const f = strategy?.definition?.filters || {}
  return {
    id: strategy?.id || null,
    name: strategy?.name || '',
    enabled: strategy?.enabled ?? true,
    definition: {
      source: 'congress',
      filters: {
        direction: f.direction || '',
        minCopyScore: f.minCopyScore ?? '',
        minConfidence: f.minConfidence ?? '',
        maxDisclosureLagDays: f.maxDisclosureLagDays ?? '',
        maxDriftPct: f.maxDriftPct ?? '',
        minClusterCount: f.minClusterCount ?? '',
        minRelevanceScore: f.minRelevanceScore ?? '',
        politicians: (f.politicians || []).join(', '),
        excludePoliticians: (f.excludePoliticians || []).join(', '),
        sectors: (f.sectors || []).join(', '),
        excludeWarnings: (f.excludeWarnings || []).join(', '),
        minAmountMid: f.minAmountMid ?? '',
        minEdgeScore: f.minEdgeScore ?? '',
      },
      action: {
        mode: strategy?.definition?.action?.mode || 'watch',
        fund: strategy?.definition?.action?.fund || 'paper',
        notionalUsd: strategy?.definition?.action?.notionalUsd ?? 500,
      },
    },
  }
}

function list(value) {
  return String(value || '').split(',').map((v) => v.trim()).filter(Boolean)
}

function numberOrNull(value) {
  return value === '' || value == null ? null : Number(value)
}

function toPayload(form) {
  const f = form.definition.filters
  return {
    name: form.name,
    enabled: form.enabled,
    definition: {
      source: 'congress',
      filters: {
        direction: f.direction || null,
        minCopyScore: numberOrNull(f.minCopyScore),
        minConfidence: numberOrNull(f.minConfidence),
        maxDisclosureLagDays: numberOrNull(f.maxDisclosureLagDays),
        maxDriftPct: numberOrNull(f.maxDriftPct),
        minClusterCount: numberOrNull(f.minClusterCount),
        minRelevanceScore: numberOrNull(f.minRelevanceScore),
        politicians: list(f.politicians),
        excludePoliticians: list(f.excludePoliticians),
        sectors: list(f.sectors),
        excludeWarnings: list(f.excludeWarnings),
        minAmountMid: numberOrNull(f.minAmountMid),
        minEdgeScore: numberOrNull(f.minEdgeScore),
      },
      action: {
        mode: form.definition.action.mode,
        fund: form.definition.action.fund,
        notionalUsd: Number(form.definition.action.notionalUsd || 1),
      },
    },
  }
}

export default function Strategies() {
  const [strategies, setStrategies] = useState([])
  const [form, setForm] = useState(fromDefinition({ definition: emptyDefinition }))
  const [error, setError] = useState(null)
  const [message, setMessage] = useState(null)
  const [runningId, setRunningId] = useState(null)
  const [backtest, setBacktest] = useState(null)
  const [range, setRange] = useState({
    startDate: '2024-01-01',
    endDate: new Date().toISOString().slice(0, 10),
    notionalPerTrade: 500,
    exitRule: 'hold_90',
  })

  const load = useCallback(() => {
    api.strategies().then(setStrategies).catch((e) => setError(e.message))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const setFilter = (key, value) => {
    setForm((current) => ({
      ...current,
      definition: {
        ...current.definition,
        filters: { ...current.definition.filters, [key]: value },
      },
    }))
  }

  const setAction = (key, value) => {
    setForm((current) => ({
      ...current,
      definition: {
        ...current.definition,
        action: { ...current.definition.action, [key]: value },
      },
    }))
  }

  const save = async () => {
    setError(null)
    setMessage(null)
    try {
      const payload = toPayload(form)
      if (form.id) await api.updateStrategy(form.id, payload)
      else await api.createStrategy(payload)
      setMessage('Strategy saved')
      setForm(fromDefinition({ definition: emptyDefinition }))
      load()
    } catch (e) {
      setError(e.message)
    }
  }

  const toggle = async (strategy) => {
    await api.updateStrategy(strategy.id, { enabled: !strategy.enabled })
    load()
  }

  const remove = async (strategy) => {
    if (!window.confirm(`Delete strategy "${strategy.name}"?`)) return
    await api.deleteStrategy(strategy.id)
    load()
  }

  const runBacktest = async (strategy) => {
    setRunningId(strategy.id)
    setError(null)
    setBacktest(null)
    try {
      setBacktest(await api.runStrategyBacktest(strategy.id, {
        ...range,
        notionalPerTrade: Number(range.notionalPerTrade),
      }))
    } catch (e) {
      setError(e.message)
    } finally {
      setRunningId(null)
    }
  }

  return (
    <div>
      <section style={card}>
        <h3>{form.id ? 'Edit Strategy' : 'New Strategy'} <HelpLink slug="strategies" /></h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
          <Field label="Name">
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Enabled">
            <select value={form.enabled ? 'yes' : 'no'} onChange={(e) => setForm({ ...form, enabled: e.target.value === 'yes' })}>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </Field>
          <Field label="Direction">
            <select value={form.definition.filters.direction} onChange={(e) => setFilter('direction', e.target.value)}>
              <option value="">Either</option>
              <option value="buy">Buy</option>
              <option value="sell">Sell</option>
            </select>
          </Field>
          <Field label="Min copy score">
            <input type="number" value={form.definition.filters.minCopyScore} onChange={(e) => setFilter('minCopyScore', e.target.value)} />
          </Field>
          <Field label="Min confidence">
            <input type="number" step="0.05" min="0" max="1" value={form.definition.filters.minConfidence} onChange={(e) => setFilter('minConfidence', e.target.value)} />
          </Field>
          <Field label="Max lag days">
            <input type="number" value={form.definition.filters.maxDisclosureLagDays} onChange={(e) => setFilter('maxDisclosureLagDays', e.target.value)} />
          </Field>
          <Field label="Max drift %">
            <input type="number" value={form.definition.filters.maxDriftPct} onChange={(e) => setFilter('maxDriftPct', e.target.value)} />
          </Field>
          <Field label="Min cluster count">
            <input type="number" value={form.definition.filters.minClusterCount} onChange={(e) => setFilter('minClusterCount', e.target.value)} />
          </Field>
          <Field label="Min relevance">
            <input type="number" value={form.definition.filters.minRelevanceScore} onChange={(e) => setFilter('minRelevanceScore', e.target.value)} />
          </Field>
          <Field label="Min amount mid">
            <input type="number" value={form.definition.filters.minAmountMid} onChange={(e) => setFilter('minAmountMid', e.target.value)} />
          </Field>
          <Field label="Min edge score">
            <input type="number" value={form.definition.filters.minEdgeScore} onChange={(e) => setFilter('minEdgeScore', e.target.value)} />
          </Field>
          <Field label="Politicians">
            <input placeholder="comma separated" value={form.definition.filters.politicians} onChange={(e) => setFilter('politicians', e.target.value)} />
          </Field>
          <Field label="Exclude politicians">
            <input placeholder="comma separated" value={form.definition.filters.excludePoliticians} onChange={(e) => setFilter('excludePoliticians', e.target.value)} />
          </Field>
          <Field label="Sectors">
            <input placeholder="comma separated" value={form.definition.filters.sectors} onChange={(e) => setFilter('sectors', e.target.value)} />
          </Field>
          <Field label="Exclude warnings">
            <input placeholder="stale-filing, illiquid" value={form.definition.filters.excludeWarnings} onChange={(e) => setFilter('excludeWarnings', e.target.value)} />
          </Field>
          <Field label="Action">
            <select value={form.definition.action.mode} onChange={(e) => setAction('mode', e.target.value)}>
              <option value="watch">Watch</option>
              <option value="paper">Paper signal</option>
              <option value="manual">Manual approval</option>
              <option value="auto">Auto signal</option>
            </select>
          </Field>
          <Field label="Fund">
            <input value={form.definition.action.fund} onChange={(e) => setAction('fund', e.target.value)} />
          </Field>
          <Field label="Notional USD">
            <input type="number" min="1" value={form.definition.action.notionalUsd} onChange={(e) => setAction('notionalUsd', e.target.value)} />
          </Field>
        </div>
        <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
          <button onClick={save} style={{ borderColor: 'var(--color-accent-blue)' }}>{form.id ? 'Update strategy' : 'Create strategy'}</button>
          {form.id && <button onClick={() => setForm(fromDefinition({ definition: emptyDefinition }))}>Cancel edit</button>}
        </div>
        {message && <p style={{ color: 'var(--color-bullish)' }}>{message}</p>}
        {error && <p style={{ color: 'var(--color-bearish)' }}>{error}</p>}
      </section>

      <section style={card}>
        <h3>Backtest Settings</h3>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Field label="From"><input type="date" value={range.startDate} onChange={(e) => setRange({ ...range, startDate: e.target.value })} /></Field>
          <Field label="To"><input type="date" value={range.endDate} onChange={(e) => setRange({ ...range, endDate: e.target.value })} /></Field>
          <Field label="$ per trade"><input type="number" value={range.notionalPerTrade} onChange={(e) => setRange({ ...range, notionalPerTrade: e.target.value })} /></Field>
          <Field label="Exit rule">
            <select value={range.exitRule} onChange={(e) => setRange({ ...range, exitRule: e.target.value })}>
              <option value="hold_30">Hold 30 days</option>
              <option value="hold_90">Hold 90 days</option>
              <option value="hold_to_present">Hold to present</option>
            </select>
          </Field>
        </div>
      </section>

      <section style={card}>
        <h3>Strategies</h3>
        {strategies.map((strategy) => (
          <div key={strategy.id} style={row}>
            <div>
              <strong>{strategy.name}</strong>
              <span style={{ color: strategy.enabled ? 'var(--color-bullish)' : 'var(--color-text-muted)', marginLeft: 8 }}>
                {strategy.enabled ? 'enabled' : 'disabled'}
              </span>
              <div style={{ color: 'var(--color-text-muted)', fontSize: '0.85em' }}>
                {describe(strategy.definition)}
              </div>
              {strategy.matches?.length > 0 && (
                <div style={{ marginTop: 6, fontSize: '0.85em' }}>
                  Last match: {strategy.matches[0].trade_key} {'->'} {strategy.matches[0].outcome || 'pending'}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button onClick={() => toggle(strategy)}>{strategy.enabled ? 'Disable' : 'Enable'}</button>
              <button onClick={() => setForm(fromDefinition(strategy))}>Edit</button>
              <button onClick={() => runBacktest(strategy)} disabled={runningId === strategy.id}>
                {runningId === strategy.id ? 'Running...' : 'Backtest'}
              </button>
              <button onClick={() => remove(strategy)}>Delete</button>
            </div>
          </div>
        ))}
      </section>

      {backtest && (
        <section style={card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <h3 style={{ marginTop: 0 }}>Strategy Backtest Result</h3>
            <PromoteButton
              from={{
                kind: 'strategy-backtest',
                strategyId: backtest.results?.strategy?.id,
                notionalPerTrade: backtest.results?.strategy?.definition?.action?.notionalUsd,
              }}
              defaultName={`${backtest.results?.strategy?.name || 'Strategy'} (promoted)`}
              defaultNotional={backtest.results?.strategy?.definition?.action?.notionalUsd || 500}
            />
          </div>
          <p>
            {backtest.results.strategy.name}: {backtest.results.summary.totalTrades} simulated trades,
            return {backtest.results.summary.returnPct?.toFixed?.(2) ?? backtest.results.summary.returnPct}%,
            P&L ${backtest.results.summary.totalPnl?.toFixed?.(2) ?? backtest.results.summary.totalPnl}.
          </p>
          <p style={{ color: 'var(--color-text-muted)' }}>{backtest.results.limitation}</p>
        </section>
      )}
    </div>
  )
}

function describe(definition) {
  const f = definition.filters || {}
  const parts = []
  if (f.direction) parts.push(f.direction)
  if (f.minCopyScore != null) parts.push(`score >= ${f.minCopyScore}`)
  if (f.minRelevanceScore != null) parts.push(`relevance >= ${f.minRelevanceScore}`)
  if (f.minClusterCount != null) parts.push(`cluster >= ${f.minClusterCount}`)
  if (f.maxDisclosureLagDays != null) parts.push(`lag <= ${f.maxDisclosureLagDays}d`)
  return `${parts.join(', ') || 'no filters'} -> ${definition.action?.mode || 'watch'}`
}

function Field({ label, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ color: 'var(--color-text-muted)', fontSize: '0.8em' }}>{label}</span>
      {children}
    </label>
  )
}

const card = { background: 'var(--color-bg-panel)', border: '1px solid var(--color-border-subtle)', borderRadius: 10, padding: 16, marginBottom: 16 }
const row = { display: 'flex', justifyContent: 'space-between', gap: 12, padding: '12px 0', borderTop: '1px solid var(--color-border-subtle)' }
