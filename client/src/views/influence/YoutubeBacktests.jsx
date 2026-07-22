import { useEffect, useState } from 'react'
import { api } from '../../api.js'
import { card, muted } from './ui.js'

export default function YoutubeBacktests() {
  const [runs, setRuns] = useState([])
  const [result, setResult] = useState(null)
  const [config, setConfig] = useState({
    name: 'YouTube creator mention backtest',
    minMentionQualityScore: 20,
    exitWindows: ['1h', '24h', '7d', '30d'],
  })
  const [error, setError] = useState(null)
  const [running, setRunning] = useState(false)

  const refresh = () => api.youtubeBacktests().then(setRuns).catch(() => {})
  useEffect(() => { refresh() }, [])

  const run = async () => {
    setRunning(true)
    setError(null)
    try {
      const res = await api.runYoutubeBacktest(config)
      setResult(res)
      refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setRunning(false)
    }
  }

  return (
    <div>
      <section style={card}>
        <h3>Create Backtest</h3>
        <p style={muted}>Consolidates repeated transcript occurrences into one video–asset thesis and uses real provider prices. Missing prices remain missing.</p>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Field label="Name">
            <input value={config.name} onChange={(e) => setConfig({ ...config, name: e.target.value })} style={{ width: 260 }} />
          </Field>
          <Field label="Min quality">
            <input type="number" value={config.minMentionQualityScore} onChange={(e) => setConfig({ ...config, minMentionQualityScore: Number(e.target.value) })} style={{ width: 90 }} />
          </Field>
          <Field label="Start date">
            <input type="date" value={config.startDate || ''} onChange={(e) => setConfig({ ...config, startDate: e.target.value || undefined })} />
          </Field>
          <Field label="End date">
            <input type="date" value={config.endDate || ''} onChange={(e) => setConfig({ ...config, endDate: e.target.value || undefined })} />
          </Field>
          <Field label="Direction">
            <select value={config.directions?.[0] || ''} onChange={(e) => setConfig({ ...config, directions: e.target.value ? [e.target.value] : undefined })}>
              <option value="">all</option>
              <option value="bullish">bullish</option>
              <option value="bearish">bearish</option>
            </select>
          </Field>
          <button onClick={run} disabled={running}>{running ? 'Running…' : 'Run backtest'}</button>
        </div>
        {error && <p style={{ color: 'var(--color-bearish)' }}>{error}</p>}
      </section>

      {result && (
        <section style={card}>
          <h3>Latest Result</h3>
          {result.summary?.warning && <p style={{ color: 'var(--color-warning)' }}>{result.summary.warning}</p>}
          {result.summary?.funnel && (
            <p style={muted}>
              {result.summary.funnel.rawOccurrences} raw occurrences → {result.summary.funnel.canonicalSignals} independent video–asset signals
              {' '}({result.summary.funnel.directionConflicts} direction conflicts excluded) → {result.summary.funnel.withDirection} bullish/bearish
              {' '}→ {result.summary.funnel.afterQualityFilters} after filters
              {result.summary.funnel.withDirection < result.summary.funnel.mentionsTotal &&
                ' — unclassified mentions need the classifier run before they can be backtested'}
            </p>
          )}
          <table>
            <thead><tr><th>Window</th><th>Avg return</th><th>Win rate</th></tr></thead>
            <tbody>
              {Object.entries(result.summary?.byWindow || {}).map(([window, row]) => (
                <tr key={window}>
                  <td>{window}</td>
                  <td>{row.averageReturn == null ? '—' : `${row.averageReturn.toFixed(2)}%`}</td>
                  <td>{row.winRate == null ? '—' : `${(row.winRate * 100).toFixed(0)}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section style={card}>
        <h3>Saved Runs</h3>
        {runs.length === 0 ? <p style={muted}>No YouTube backtests yet.</p> : (
          <table>
            <thead><tr><th>ID</th><th>Name</th><th>Status</th><th>Created</th></tr></thead>
            <tbody>
              {runs.map((r) => <tr key={r.id}><td>{r.id}</td><td>{r.name}</td><td>{r.status}</td><td>{r.created_at}</td></tr>)}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}

function Field({ label, children }) {
  return <label style={{ display: 'grid', gap: 4, color: 'var(--color-text-muted)', fontSize: '0.85em' }}>{label}{children}</label>
}
