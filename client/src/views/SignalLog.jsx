import { Fragment, useEffect, useState } from 'react'
import { api } from '../api.js'
import { SignalTable } from './Dashboard.jsx'
import {
  EvidenceDrawer,
  PageHeader,
  SectionPanel,
  SignalCard,
} from '../components/intel/components.jsx'
import { normalizeSignal } from '../components/intel/signalUtils.js'

export default function SignalLog() {
  const [signals, setSignals] = useState([])
  const [audit, setAudit] = useState(null)
  const [auditError, setAuditError] = useState('')

  useEffect(() => {
    api.signals(500).then(setSignals).catch(() => {})
  }, [])

  const loadAudit = async (signal) => {
    setAuditError('')
    try {
      setAudit(signal.order_id ? await api.auditOrder(signal.order_id) : await api.auditSignal(signal.id))
    } catch (err) {
      setAudit(null)
      setAuditError(err.message)
    }
  }

  return (
    <section>
      <PageHeader
        eyebrow="Signals"
        helpSlug="signals"
        title="Normalized Signal Feed"
        description="Every signal is treated as an auditable intelligence object: action, confidence, risk, evidence, and decision trail."
        meta={`${signals.length} signals loaded · Manual review recommended when evidence is thin`}
      />
      <ReviewQueue />

      <SectionPanel
        title="Signal Cards"
        description="Suggested actions avoid direct buy/sell language. Historical follow-through is positive only when proven by evidence."
      >
        {signals.length === 0 ? (
          <p className="intel-muted">No signals yet.</p>
        ) : (
          <div className="intel-signal-list">
            {signals.slice(0, 20).map((signal, i) => (
              <SignalCard
                key={`${signal.id}-${signal.fund ?? i}`}
                {...normalizeSignal(signal)}
                onOpen={() => loadAudit(signal)}
              />
            ))}
          </div>
        )}
      </SectionPanel>

      {auditError && <p style={{ color: '#fca5a5' }}>{auditError}</p>}
      {audit && <AuditTimeline audit={audit} onClose={() => setAudit(null)} />}
      <SectionPanel
        title="Full Signal and Decision Log"
        description="Dense table view for rejected signals, risk-manager reasoning, orders, and source references."
      >
        <SignalTable signals={signals} onAudit={loadAudit} />
      </SectionPanel>
    </section>
  )
}

function AuditTimeline({ audit, onClose }) {
  const decisions = audit.decisions || []
  return (
    <SectionPanel>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
        <h3>Audit Timeline - {audit.signal?.ticker} {audit.signal?.direction}</h3>
        <button onClick={onClose}>Close</button>
      </div>
      <EvidenceDrawer
        signalId={audit.signal?.id}
        items={[
          audit.sourceTrade && {
            type: 'filing',
            title: 'Source filing',
            timestamp: audit.sourceTrade.disclosure_date,
            body: `${audit.sourceTrade.politician} disclosed ${audit.sourceTrade.type} ${audit.sourceTrade.ticker}. Disclosure lag and filing quality affect actionability.`,
            href: audit.sourceTrade.source_url,
            confidence: audit.sourceTrade.parse_confidence,
          },
          audit.score && {
            type: 'backtest',
            title: 'Copy score',
            body: `${audit.score.score} / 100 - ${audit.score.recommendation}. Sample size and stale-signal warnings should be reviewed.`,
            confidence: audit.score.confidence,
          },
          audit.strategyMatch && {
            type: 'risk_check',
            title: 'Strategy approval',
            body: `${audit.strategyMatch.strategy_name || `Strategy ${audit.strategyMatch.strategy_id}`} returned ${audit.strategyMatch.outcome}.`,
          },
        ].filter(Boolean)}
      />
      <TimelineStep title="Source Trade">
        {audit.sourceTrade ? (
          <>
            <div>{audit.sourceTrade.politician} disclosed {audit.sourceTrade.type} {audit.sourceTrade.ticker}</div>
            <div style={muted}>Trade key: {audit.sourceTrade.trade_key}</div>
            <div style={muted}>Disclosed {audit.sourceTrade.disclosure_date || 'unknown'} - Source {audit.sourceTrade.source || 'unknown'}</div>
            {audit.sourceTrade.source_url && (
              <a href={audit.sourceTrade.source_url} target="_blank" rel="noreferrer" style={{ color: '#818cf8' }}>Source filing</a>
            )}
            {audit.qualityFlags?.length > 0 && <JsonBlock value={audit.qualityFlags} />}
          </>
        ) : <div style={muted}>No archived source trade attached to this signal.</div>}
      </TimelineStep>
      <TimelineStep title="Score">
        {audit.score ? (
          <>
            <div>{audit.score.score} / 100 - {audit.score.recommendation} - confidence {audit.score.confidence}</div>
            <JsonBlock value={{ factors: audit.score.factors, warnings: audit.score.warnings }} />
          </>
        ) : <div style={muted}>No copy score attached.</div>}
      </TimelineStep>
      <TimelineStep title="Strategy / Approval">
        {audit.strategyMatch ? (
          <>
            <div>{audit.strategyMatch.strategy_name || `Strategy ${audit.strategyMatch.strategy_id}`} - {audit.strategyMatch.outcome}</div>
            <JsonBlock value={{ matched: !!audit.strategyMatch.matched, failedFilters: audit.strategyMatch.failed_filters }} />
          </>
        ) : <div style={muted}>No strategy match for this signal.</div>}
        {audit.approval && (
          <div style={{ marginTop: 8 }}>
            Approval #{audit.approval.id}: {audit.approval.status}
            <span style={muted}> created {audit.approval.created_at}, resolved {audit.approval.resolved_at || 'not resolved'}</span>
          </div>
        )}
      </TimelineStep>
      <TimelineStep title="Signal">
        <div>{audit.signal?.source} signal #{audit.signal?.id}: {audit.signal?.rationale}</div>
        {audit.signal?.rawReference && <JsonBlock value={audit.signal.rawReference} />}
      </TimelineStep>
      <TimelineStep title="Risk Decisions / Orders / Fills">
        {decisions.length === 0 ? <div style={muted}>No fund decisions recorded.</div> : decisions.map((d) => (
          <div key={d.id} style={{ marginBottom: 12 }}>
            <div>
              <strong>{d.fund}</strong>: {d.approved ? 'approved' : 'rejected'} - {d.reason}
              {d.notional_usd != null && <span style={muted}> (${d.notional_usd})</span>}
            </div>
            <ol style={{ margin: '8px 0 8px 18px', color: '#d4d4d8' }}>
              {(d.checks || []).map((check, i) => (
                <li key={`${d.id}-${check.check}-${i}`}>
                  <span style={{ color: check.pass ? '#86efac' : '#fca5a5' }}>{check.pass ? 'pass' : 'fail'}</span>
                  {' '}{check.check}: <span style={muted}>{check.detail}</span>
                </li>
              ))}
            </ol>
            {(d.orders || []).map((o) => (
              <div key={o.id} style={{ marginLeft: 12, color: '#d4d4d8' }}>
                Order #{o.id}: {o.side} {o.ticker} ${o.notional_usd ?? '-'} - {o.status}
                {o.alpaca_order_id && <span style={muted}> ({o.alpaca_order_id})</span>}
                {o.fills?.length > 0 && <JsonBlock value={o.fills} />}
              </div>
            ))}
          </div>
        ))}
      </TimelineStep>
    </SectionPanel>
  )
}

function TimelineStep({ title, children }) {
  return (
    <div style={{ borderLeft: '2px solid #3f3f46', padding: '0 0 14px 14px', marginLeft: 6 }}>
      <h4 style={{ margin: '0 0 6px' }}>{title}</h4>
      <div>{children}</div>
    </div>
  )
}

function JsonBlock({ value }) {
  return (
    <pre style={{ fontSize: '0.75em', background: '#0f1117', padding: 10, borderRadius: 6, overflow: 'auto', maxHeight: 220 }}>
      {JSON.stringify(value, null, 2)}
    </pre>
  )
}

function ReviewQueue() {
  const [items, setItems] = useState([])
  const [expanded, setExpanded] = useState(null)

  const refresh = () => api.reviewQueue('pending').then(setItems).catch(() => {})
  useEffect(() => { refresh() }, [])

  const resolve = async (id, status) => {
    try {
      await api.resolveReview(id, status)
    } catch { /* ignore */ }
    refresh()
  }

  if (items.length === 0) return null

  return (
    <SectionPanel title="Data-Quality Review Queue" description="Low-confidence filings are held out of automation until an analyst reviews the evidence.">
      <h3>Data-quality review queue <span style={{ color: '#eab308' }}>({items.length} pending)</span></h3>
      <table>
        <thead>
          <tr>
            <th>Politician</th><th>Ticker</th><th>Dir</th><th>Conf</th><th>Reason</th><th></th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => (
            <Fragment key={it.id}>
              <tr>
                <td>{it.politician}</td>
                <td>{it.ticker}</td>
                <td style={{ color: it.type === 'buy' ? '#86efac' : '#fca5a5' }}>{it.type}</td>
                <td>{it.parse_confidence}</td>
                <td style={{ maxWidth: 300, color: '#a1a1aa' }}>{it.reason}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button onClick={() => setExpanded(expanded === it.id ? null : it.id)} style={{ marginRight: 6 }}>
                    {expanded === it.id ? 'Hide' : 'Filing'}
                  </button>
                  <button onClick={() => resolve(it.id, 'approved')} style={{ marginRight: 6 }}>Approve</button>
                  <button onClick={() => resolve(it.id, 'rejected')}>Reject</button>
                </td>
              </tr>
              {expanded === it.id && (
                <tr>
                  <td colSpan={6}>
                    {it.source_url && (
                      <div style={{ marginBottom: 8 }}>
                        <a href={it.source_url} target="_blank" rel="noreferrer" style={{ color: '#818cf8' }}>
                          {it.source_url}
                        </a>
                      </div>
                    )}
                    <pre style={{ fontSize: '0.75em', background: '#16181d', padding: 10, borderRadius: 6, overflow: 'auto', maxHeight: 240 }}>
                      {JSON.stringify(it.raw, null, 2)}
                    </pre>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </SectionPanel>
  )
}

const muted = {
  color: '#a1a1aa',
  fontSize: '0.9em',
}
