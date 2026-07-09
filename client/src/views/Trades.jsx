import { Fragment, useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'

export default function Trades() {
  const [rows, setRows] = useState([])
  const [filters, setFilters] = useState({ since: '', minScore: '', recommendation: '', politician: '', ticker: '' })
  const [expanded, setExpanded] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = async () => {
    setError(null)
    const data = await api.trades({ ...filters, limit: 250 })
    setRows(data)
  }

  useEffect(() => {
    load().catch((e) => setError(e.message)).finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const scoreOne = async (tradeKey) => {
    try {
      await api.scoreTrade(tradeKey)
      await load()
      setExpanded(tradeKey)
    } catch (e) {
      setError(e.message)
    }
  }

  const politicians = useMemo(() => [...new Set(rows.map((r) => r.politician).filter(Boolean))].sort(), [rows])

  return (
    <section style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div>
          <h3 style={{ marginTop: 0 }}>Congress Trade Feed</h3>
          <p style={{ color: '#a1a1aa', fontSize: '0.9em', margin: 0 }}>
            Archived disclosures joined to explainable copy-worthiness scores and do-not-copy warnings.
          </p>
        </div>
        <button onClick={() => load().catch((e) => setError(e.message))}>Refresh</button>
      </div>

      <FilterBar filters={filters} setFilters={setFilters} politicians={politicians} onApply={() => load().catch((e) => setError(e.message))} />
      {error && <p style={{ color: '#fca5a5' }}>{error}</p>}
      {loading ? <p>Loading trades...</p> : <TradeTable rows={rows} expanded={expanded} setExpanded={setExpanded} scoreOne={scoreOne} />}
    </section>
  )
}

function FilterBar({ filters, setFilters, politicians, onApply }) {
  const set = (key, value) => setFilters((f) => ({ ...f, [key]: value }))
  return (
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'end', margin: '16px 0' }}>
      <Label label="Since">
        <input type="date" value={filters.since} onChange={(e) => set('since', e.target.value)} />
      </Label>
      <Label label="Min score">
        <input type="number" min="0" max="100" value={filters.minScore} onChange={(e) => set('minScore', e.target.value)} style={{ width: 90 }} />
      </Label>
      <Label label="Recommendation">
        <select value={filters.recommendation} onChange={(e) => set('recommendation', e.target.value)}>
          <option value="">Any</option>
          <option value="copy-candidate">Copy candidate</option>
          <option value="watchlist">Watchlist</option>
          <option value="avoid">Avoid</option>
          <option value="manual-review">Manual review</option>
        </select>
      </Label>
      <Label label="Politician">
        <input list="politicians" value={filters.politician} onChange={(e) => set('politician', e.target.value)} placeholder="Any" />
        <datalist id="politicians">{politicians.map((p) => <option key={p} value={p} />)}</datalist>
      </Label>
      <Label label="Ticker">
        <input value={filters.ticker} onChange={(e) => set('ticker', e.target.value.toUpperCase())} placeholder="Any" style={{ width: 90 }} />
      </Label>
      <button onClick={onApply}>Apply</button>
    </div>
  )
}

function Label({ label, children }) {
  return (
    <label style={{ display: 'grid', gap: 4, color: '#a1a1aa', fontSize: '0.78em' }}>
      {label}
      {children}
    </label>
  )
}

function TradeTable({ rows, expanded, setExpanded, scoreOne }) {
  if (rows.length === 0) return <p style={{ color: '#a1a1aa' }}>No archived trades match these filters.</p>
  return (
    <table>
      <thead>
        <tr>
          <th>Disclosure</th><th>Politician</th><th>Ticker</th><th>Dir</th><th>Amount</th><th>Lag</th><th>Score</th><th>Recommendation</th><th>Warnings</th><th></th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <Fragment key={r.trade_key}>
            <tr>
              <td>{r.disclosure_date || '-'}</td>
              <td>{r.politician}</td>
              <td>{r.ticker}</td>
              <td style={{ color: r.type === 'buy' ? '#86efac' : '#fca5a5' }}>{r.type}</td>
              <td>{r.amount_range || (r.amount_mid ? `$${Number(r.amount_mid).toLocaleString()}` : '-')}</td>
              <td>{lag(r)}</td>
              <td>{r.score == null ? <span style={{ color: '#a1a1aa' }}>unscored</span> : <ScoreBadge score={r.score} />}</td>
              <td><Recommendation value={r.recommendation} /></td>
              <td><Warnings warnings={r.warnings || []} /></td>
              <td style={{ whiteSpace: 'nowrap' }}>
                <button onClick={() => setExpanded(expanded === r.trade_key ? null : r.trade_key)} style={{ marginRight: 6 }}>
                  {expanded === r.trade_key ? 'Hide' : 'Details'}
                </button>
                {r.score == null && <button onClick={() => scoreOne(r.trade_key)}>Score</button>}
              </td>
            </tr>
            {expanded === r.trade_key && (
              <tr>
                <td colSpan={10}>
                  {r.score != null && <ThesisCard tradeKey={r.trade_key} />}
                  <ConnectionsPanel tradeKey={r.trade_key} />
                  <FactorBreakdown row={r} />
                </td>
              </tr>
            )}
          </Fragment>
        ))}
      </tbody>
    </table>
  )
}

function ScoreBadge({ score }) {
  const color = score >= 75 ? '#22c55e' : score >= 55 ? '#eab308' : '#ef4444'
  return <span style={{ ...chip, borderColor: color, color }}>{Number(score).toFixed(1)}</span>
}

function Recommendation({ value }) {
  if (!value) return <span style={{ color: '#a1a1aa' }}>-</span>
  const color = value === 'copy-candidate' ? '#86efac' : value === 'watchlist' ? '#fde68a' : value === 'manual-review' ? '#93c5fd' : '#fca5a5'
  return <span style={{ ...chip, color, borderColor: color }}>{value}</span>
}

function Warnings({ warnings }) {
  if (!warnings.length) return <span style={{ color: '#a1a1aa' }}>-</span>
  return (
    <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
      {warnings.map((w) => (
        <span key={w.code} title={w.message} style={{ ...chip, color: w.severity === 'critical' ? '#fca5a5' : '#fde68a' }}>
          {w.code}
        </span>
      ))}
    </span>
  )
}

function ThesisCard({ tradeKey }) {
  const [card, setCard] = useState(null)
  const [polished, setPolished] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let live = true
    setLoading(true)
    setError(null)
    api.thesisCard(tradeKey)
      .then((data) => {
        if (!live) return
        setCard(data.card)
        setPolished(data.polished || null)
      })
      .catch((e) => live && setError(e.message))
      .finally(() => live && setLoading(false))
    return () => { live = false }
  }, [tradeKey])

  if (loading) return <div style={{ ...cardBox, color: '#a1a1aa' }}>Building thesis card…</div>
  if (error) return <div style={{ ...cardBox, color: '#fca5a5' }}>Card error: {error}</div>
  if (!card) return null

  return (
    <div style={cardBox}>
      {polished && (
        <p style={{ margin: '0 0 12px', fontStyle: 'italic', color: '#d4d4d8', lineHeight: 1.5 }}>{polished}</p>
      )}
      <CardSection title="What happened">
        <p style={{ margin: 0 }}>{card.what}</p>
      </CardSection>
      {card.whyItMatters?.length > 0 && (
        <CardSection title="Why it might matter">
          <ul style={bullets}>{card.whyItMatters.map((s, i) => <li key={i}>{s}</li>)}</ul>
        </CardSection>
      )}
      {card.sinceThen && (
        <CardSection title="Since then">
          <p style={{ margin: 0 }}>{card.sinceThen}</p>
        </CardSection>
      )}
      <CardSection title="Signal strength">
        <p style={{ margin: 0 }}>
          Copy score <strong>{card.signal.copyScore}</strong> · confidence {Math.round((card.signal.confidence ?? 0) * 100)}% ·{' '}
          <Recommendation value={card.signal.recommendation} />
        </p>
        {card.signal.politicianEdge && <p style={{ margin: '4px 0 0', color: '#a1a1aa' }}>{card.signal.politicianEdge}</p>}
      </CardSection>
      {card.risks?.length > 0 && (
        <CardSection title="Risks">
          <ul style={bullets}>{card.risks.map((s, i) => <li key={i} style={{ color: '#fca5a5' }}>{s}</li>)}</ul>
        </CardSection>
      )}
      <CardSection title="Suggested action">
        <Recommendation value={card.suggestedAction} />
      </CardSection>
    </div>
  )
}

function CardSection({ title, children }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ color: '#71717a', fontSize: '0.72em', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>{title}</div>
      {children}
    </div>
  )
}

function ConnectionsPanel({ tradeKey }) {
  const [context, setContext] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let live = true
    setContext(null)
    setError(null)
    api.tradeGraph(tradeKey)
      .then((data) => live && setContext(data))
      .catch((e) => live && setError(e.message))
    return () => { live = false }
  }, [tradeKey])

  if (error) return <div style={{ ...cardBox, color: '#fca5a5' }}>Connections error: {error}</div>
  if (!context) return <div style={{ ...cardBox, color: '#a1a1aa' }}>Loading connections…</div>

  return (
    <div style={cardBox}>
      <CardSection title="Connections">
        {!context.politician && <p style={{ margin: 0, color: '#a1a1aa' }}>No linked Bioguide ID yet. Run graph refresh to link the archive.</p>}
        {context.politician && (
          <p style={{ margin: '0 0 8px' }}>
            {context.politician.full_name} · {context.politician.party || 'unknown party'} · {context.politician.state || 'unknown state'} · {context.politician.chamber || 'unknown chamber'}
          </p>
        )}
        <ConnectionList
          title="Committees"
          rows={context.committees || []}
          empty="No committee memberships linked."
          render={(c) => `${c.name}${c.role ? ` (${c.role})` : ''}${c.sectors?.length ? ` · ${c.sectors.join(', ')}` : ''}`}
        />
        <ConnectionList
          title="Bills"
          rows={context.bills || []}
          empty="No recent related bills."
          render={(b) => `${b.latest_action_date || 'unknown date'} · ${b.title || b.bill_id}`}
          link={(b) => b.source_url}
        />
        <ConnectionList
          title="Lobbying"
          rows={context.lobbyingFilings || []}
          empty="No recent company lobbying filings."
          render={(l) => `${l.filed_at || 'unknown date'} · ${l.client_name || l.ticker}${l.issues?.length ? ` · ${l.issues.join(', ')}` : ''}`}
          link={(l) => l.source_url}
        />
        <ConnectionList
          title="Contracts"
          rows={context.contracts || []}
          empty="No recent federal contracts."
          render={(c) => `${c.action_date || 'unknown date'} · ${c.awarding_agency || 'unknown agency'}${c.amount ? ` · $${Number(c.amount).toLocaleString()}` : ''}`}
          link={(c) => c.source_url}
        />
      </CardSection>
    </div>
  )
}

function ConnectionList({ title, rows, empty, render, link }) {
  const visible = rows.slice(0, 5)
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ color: '#a1a1aa', fontSize: '0.84em', marginBottom: 4 }}>{title}</div>
      {visible.length === 0 ? (
        <p style={{ margin: 0, color: '#71717a' }}>{empty}</p>
      ) : (
        <ul style={bullets}>
          {visible.map((row, i) => {
            const href = link?.(row)
            const text = render(row)
            return <li key={row.committee_id || row.bill_id || row.filing_id || row.contract_id || i}>{href ? <a href={href} target="_blank" rel="noreferrer">{text}</a> : text}</li>
          })}
        </ul>
      )}
    </div>
  )
}

function FactorBreakdown({ row }) {
  const factors = Object.entries(row.factors || {})
  return (
    <div style={{ background: '#0f1115', border: '1px solid #26282f', borderRadius: 8, padding: 12 }}>
      {factors.length === 0 ? (
        <p style={{ color: '#a1a1aa' }}>No score persisted yet. Use Score to compute one on demand.</p>
      ) : (
        <div style={{ display: 'grid', gap: 10 }}>
          <div style={{ color: '#a1a1aa' }}>
            Confidence {Math.round((row.confidence ?? 0) * 100)}% | scored {row.score_computed_at || 'unknown'}
          </div>
          {factors.map(([name, f]) => (
            <div key={name}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <strong>{labelize(name)}</strong>
                <span>{f.score}/100 | weight {f.weight}{f.hasData ? '' : ' | no data'}</span>
              </div>
              <div style={{ height: 7, background: '#26282f', borderRadius: 999, overflow: 'hidden', margin: '5px 0' }}>
                <div style={{ width: `${Math.max(0, Math.min(100, f.score))}%`, height: '100%', background: f.score >= 75 ? '#22c55e' : f.score >= 55 ? '#eab308' : '#ef4444' }} />
              </div>
              <div style={{ color: '#a1a1aa', fontSize: '0.88em' }}>{f.detail}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function lag(row) {
  if (!row.transaction_date || !row.disclosure_date) return '-'
  const days = Math.floor((new Date(`${row.disclosure_date}T00:00:00Z`) - new Date(`${row.transaction_date}T00:00:00Z`)) / 86400_000)
  return Number.isFinite(days) ? `${days}d` : '-'
}

function labelize(value) {
  return value.replace(/[A-Z]/g, (m) => ` ${m.toLowerCase()}`).replace(/^./, (m) => m.toUpperCase())
}

const card = {
  background: '#16181d',
  border: '1px solid #26282f',
  borderRadius: 10,
  padding: '16px 20px',
}

const chip = {
  border: '1px solid #3f3f46',
  borderRadius: 999,
  padding: '2px 7px',
  fontSize: '0.78em',
}

const cardBox = {
  background: '#0f1115',
  border: '1px solid #26282f',
  borderRadius: 8,
  padding: 14,
  marginBottom: 10,
}

const bullets = {
  margin: 0,
  paddingLeft: 18,
  display: 'grid',
  gap: 3,
}
