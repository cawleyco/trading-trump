import { useState } from 'react'
import { navigate } from '../../lib/navigate.js'

export function HelpLink({ slug }) {
  return (
    <button
      type="button"
      className="intel-help-link"
      aria-label="Open guide"
      title="How to use this page"
      onClick={() => navigate(`/app/guide/${slug}`)}
    >
      ?
    </button>
  )
}

export function PageHeader({ eyebrow, title, description, actions, meta, helpSlug }) {
  return (
    <header className="intel-page-header">
      <div>
        {eyebrow && <div className="intel-eyebrow">{eyebrow}</div>}
        <h1>
          {title}
          {helpSlug && <> <HelpLink slug={helpSlug} /></>}
        </h1>
        {description && <p>{description}</p>}
        {meta && <div className="intel-meta-row">{meta}</div>}
      </div>
      {actions && <div className="intel-header-actions">{actions}</div>}
    </header>
  )
}

export function SectionPanel({ title, description, actions, children, className = '' }) {
  return (
    <section className={`intel-panel ${className}`.trim()}>
      {(title || description || actions) && (
        <div className="intel-panel-header">
          <div>
            {title && <h2>{title}</h2>}
            {description && <p>{description}</p>}
          </div>
          {actions && <div className="intel-panel-actions">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  )
}

export function MetricCard({ label, value, helper, tone = 'neutral' }) {
  return (
    <section className={`intel-metric-card tone-${tone}`}>
      <div className="intel-metric-label">{label}</div>
      <div className="intel-metric-value">{value ?? '-'}</div>
      {helper && <div className="intel-metric-helper">{helper}</div>}
    </section>
  )
}

export function SignalBadge({ action }) {
  const normalized = normalizeAction(action)
  return <span className={`intel-badge action-${normalized}`}>{actionLabel(normalized)}</span>
}

export function SourceBadge({ sourceType, sourceName }) {
  const label = sourceTypeLabel(sourceType)
  return (
    <span className="intel-badge source-badge">
      {label}{sourceName ? ` / ${sourceName}` : ''}
    </span>
  )
}

export function DirectionBadge({ direction }) {
  const normalized = (direction || 'neutral').toLowerCase()
  return <span className={`intel-badge direction-${normalized}`}>{normalized.toUpperCase()}</span>
}

export function RiskBadge({ score }) {
  const n = Number(score || 0)
  const tone = n >= 70 ? 'bad' : n >= 40 ? 'warning' : 'good'
  return <span className={`intel-badge risk-${tone}`}>RISK {Number.isFinite(n) ? n.toFixed(0) : '-'}</span>
}

export function AssetTicker({ symbol, name }) {
  return (
    <span className="intel-ticker">
      {symbol || '-'}{name ? <small>{name}</small> : null}
    </span>
  )
}

export function ScoreGauge({ label, value, tone = 'neutral', helper }) {
  const n = clampScore(value)
  return (
    <div className={`intel-score tone-${tone}`}>
      <div className="intel-score-top">
        <span>{label}</span>
        <strong>{n}</strong>
      </div>
      <div className="intel-score-track" aria-label={`${label}: ${n} out of 100`}>
        <span style={{ width: `${n}%` }} />
      </div>
      {helper && <div className="intel-score-helper">{helper}</div>}
    </div>
  )
}

export function SignalCard({
  id,
  title,
  sourceType,
  sourceName,
  assetSymbol,
  assetName,
  direction,
  action,
  actionabilityScore,
  confidenceScore,
  riskScore,
  historicalReturnLabel,
  summary,
  timestamp,
  evidenceCount,
  onOpen,
}) {
  const content = (
    <>
      <div className="intel-signal-top">
        <div className="intel-signal-badges">
          <SignalBadge action={action} />
          <SourceBadge sourceType={sourceType} sourceName={sourceName} />
          <DirectionBadge direction={direction} />
        </div>
        <AssetTicker symbol={assetSymbol} name={assetName} />
      </div>
      <div className="intel-signal-title-row">
        <h3>{title}</h3>
        <span className="intel-time">{timestamp || id}</span>
      </div>
      <div className="intel-score-grid">
        <ScoreGauge label="Actionability" value={actionabilityScore} tone="good" />
        <ScoreGauge label="Confidence" value={confidenceScore} tone="info" />
        <ScoreGauge label="Risk" value={riskScore} tone={Number(riskScore) >= 60 ? 'bad' : 'warning'} />
      </div>
      <p className="intel-signal-summary">{summary || 'Signal detected. Evidence and follow-through should be reviewed before action.'}</p>
      <div className="intel-signal-footer">
        <span>Historical: {historicalReturnLabel || 'Edge not confirmed'}</span>
        <span>Evidence: {evidenceCount ?? 0} item{Number(evidenceCount) === 1 ? '' : 's'}</span>
      </div>
    </>
  )

  if (onOpen) {
    return (
      <button type="button" className="intel-signal-card is-clickable" onClick={onOpen}>
        {content}
      </button>
    )
  }
  return <article className="intel-signal-card">{content}</article>
}

export function DossierHeader({ entityType, name, subtitle, avatarUrl, badges = [], stats = [] }) {
  const initials = name?.split(/\s+/).slice(0, 2).map((part) => part[0]).join('') || '?'
  return (
    <section className="intel-dossier-header">
      <div className="intel-dossier-main">
        <div className="intel-avatar">
          {avatarUrl ? <img src={avatarUrl} alt="" /> : initials}
        </div>
        <div>
          <div className="intel-eyebrow">{(entityType || 'source').toUpperCase()} DOSSIER</div>
          <h1>{name}</h1>
          {subtitle && <p>{subtitle}</p>}
          {badges.length > 0 && (
            <div className="intel-dossier-badges">
              {badges.map((badge) => (
                <span key={`${badge.label}-${badge.tone}`} className={`intel-badge tone-${badge.tone || 'neutral'}`}>
                  {badge.label}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
      {stats.length > 0 && (
        <div className="intel-dossier-stats">
          {stats.map((stat) => (
            <div key={stat.label}>
              <span>{stat.label}</span>
              <strong>{stat.value ?? '-'}</strong>
              {stat.helper && <small>{stat.helper}</small>}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

export function EvidenceDrawer({ signalId, items = [] }) {
  const [open, setOpen] = useState(false)
  return (
    <section className="intel-evidence">
      <button type="button" onClick={() => setOpen(!open)}>
        {open ? 'Hide evidence' : 'Review evidence'} {signalId ? `#${signalId}` : ''}
      </button>
      {open && (
        <div className="intel-evidence-list">
          {items.length === 0 ? (
            <p>Sample size is too small for confidence.</p>
          ) : items.map((item, index) => (
            <article key={`${item.title}-${index}`}>
              <div className="intel-evidence-index">{index + 1}</div>
              <div>
                <h3>{item.title}</h3>
                <div className="intel-meta-row">
                  {item.type}{item.timestamp ? ` · ${item.timestamp}` : ''}{item.confidence != null ? ` · confidence ${item.confidence}` : ''}
                </div>
                <p>{item.body}</p>
                {item.href && <a href={item.href} target="_blank" rel="noreferrer">Open source</a>}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}

export function IntelligenceTable({ columns, rows, empty = 'No records yet.', rowKey }) {
  if (!rows || rows.length === 0) return <p className="intel-muted">{empty}</p>
  return (
    <div className="intel-table-wrap">
      <table className="intel-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} className={column.numeric ? 'is-numeric' : ''}>{column.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={rowKey ? rowKey(row, index) : row.id || index}>
              {columns.map((column) => (
                <td key={column.key} className={`${column.numeric ? 'is-numeric' : ''} ${column.mono ? 'is-mono' : ''}`.trim()}>
                  {column.render ? column.render(row) : row[column.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function EmptyState({ title = 'No intelligence yet.', body = 'Signal detected. Edge not confirmed.' }) {
  return (
    <div className="intel-empty">
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  )
}

export function LoadingSkeleton({ label = 'Loading intelligence...' }) {
  return <div className="intel-skeleton">{label}</div>
}

function normalizeAction(action) {
  return String(action || 'manual_review').toLowerCase().replace(/\s+/g, '_').replace(/-/g, '_')
}

function actionLabel(action) {
  return {
    copy_candidate: 'COPY CANDIDATE',
    watch: 'WATCH',
    avoid: 'AVOID',
    fade_candidate: 'FADE CANDIDATE',
    manual_review: 'MANUAL REVIEW',
    insufficient_data: 'INSUFFICIENT DATA',
  }[action] || action.replace(/_/g, ' ').toUpperCase()
}

function sourceTypeLabel(sourceType) {
  return {
    politician_trade: 'POLITICIAN',
    youtube: 'YOUTUBE',
    x: 'X / TWITTER',
    reddit: 'REDDIT',
    podcast: 'PODCAST',
    newsletter: 'NEWSLETTER',
    sec_filing: 'SEC FILING',
  }[sourceType] || String(sourceType || 'SOURCE').toUpperCase()
}

function clampScore(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(100, Math.round(n)))
}
