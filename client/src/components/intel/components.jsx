import { useState } from 'react'
import { navigate } from '../../lib/navigate.js'
import { InvestButton } from '../InvestButton.jsx'

const TERM_DEFINITIONS = {
  actionability: 'A 0-100 estimate of whether the signal is ready to act on now. It blends market relevance, confidence, freshness, risk checks, and whether enough evidence exists.',
  confidence: 'How strongly the classifier or scoring model trusts the direction/evidence. For sentiment this starts as 0-1 and is displayed as 0-100 on cards.',
  risk: 'A 0-100 caution score. Higher means more reasons to review or avoid, such as rejected risk checks, pump-risk flags, options exposure, low data quality, or weak evidence.',
  'open positions': 'Positions currently reported by the selected fund/account.',
  'recent signals': 'The latest normalized signal rows loaded from the bot server for the dashboard sample.',
  'data sources': 'Signal sources enabled for the selected fund, such as Congress disclosures, YouTube creator mentions, or sentiment feeds.',
  'account mode': 'Whether this fund is running against a paper account or the configured trading mode. Paper means simulated brokerage execution.',
  'top signal feed': 'The newest signals normalized into one card format. These are prompts for review, not automatic proof of edge.',
  'risk warnings': 'Signals currently rejected or marked avoid so elevated caution stays visible.',
  'risk limits': 'Configured guardrails enforced before an order can be placed for this fund.',
  'max per trade': 'Largest allowed notional order for this fund, capped by both a dollar amount and a percent of account equity.',
  'max open positions': 'Maximum number of simultaneous positions allowed before new buys are blocked.',
  'max total exposure': 'Maximum aggregate market value this fund may have open across positions.',
  'daily loss limit': 'Loss threshold that trips the fund circuit breaker and blocks more trading for the day.',
  sources: 'The signal feeds this fund subscribes to.',
  'sentiment threshold': 'Minimum sentiment confidence required before a sentiment signal can continue through the fund risk pipeline.',
  'auto-exit': 'Optional automatic stop-loss, take-profit, and max-hold rules attached after entry.',
  account: 'The brokerage account category and global trading mode reported by the server.',
  'pipeline test': 'Sends a manual test signal through the same risk checks as a real signal for the selected fund.',
  'filing speed by politician': 'Disclosure lag statistics by member. Slower filing usually lowers actionability because the market may have already moved.',
  politician: 'The public official associated with the disclosed trade row.',
  trades: 'Number of qualifying disclosure trades included in this row or score.',
  'median lag (d)': 'Median number of days between transaction date and public disclosure date.',
  '≤15d': 'Share of disclosures filed within 15 days of the transaction date.',
  '≤30d': 'Share of disclosures filed within 30 days of the transaction date.',
  '≤45d': 'Share of disclosures filed within 45 days of the transaction date.',
  'realized p&l by source': 'Cumulative profit and loss from closed positions, attributed back to the signal source that opened each position.',
  method: 'The system posture for this module: show evidence first, then decide whether a signal is actionable.',
  'enabled modules': 'Influence source modules currently available in the app.',
  'future sources': 'Influence source modules planned or staged but not yet enabled.',
  'creator alpha': 'A creator-level follow-through score from post-mention backtests. Higher means the creator\'s historical mentions more often preceded favorable moves.',
  alpha: 'The latest creator alpha score. Higher suggests stronger historical post-mention follow-through, but small samples still require review.',
  'alpha score': 'Creator alpha on a 0-100 scale, derived from historical returns, win rate, sample size, and pump/dump penalties.',
  'pump risk': 'A 0-100 warning score for hype, sponsorship, unrealistic claims, or pump/dump-like follow-through. Higher is worse.',
  'high pump-risk': 'Count of mentions whose pump-risk score is elevated enough to require extra caution.',
  'videos analyzed today': 'Videos processed today for transcript, metadata, and mention extraction.',
  'new asset mentions': 'New ticker or asset mentions detected in the current YouTube ingestion window.',
  'bullish high-quality': 'Bullish mentions that passed quality filters for relevance, specificity, and evidence.',
  'bearish high-quality': 'Bearish mentions that passed quality filters for relevance, specificity, and evidence.',
  'recent creator signals': 'Latest YouTube-derived signals built from creator mentions, classification, and evidence checks.',
  'assets trending across youtube': 'Assets with the most detected mentions across tracked YouTube channels.',
  'tracked youtube creators': 'Channels currently stored for monitoring, metadata sync, and alpha calculation.',
  'data quality': 'Coverage context for whether scores are trustworthy, including transcripts, creator history, and sample size.',
  'creator dossier index': 'Channel list ranked with creator history, detected mentions, alpha, and pump-risk context.',
  channel: 'Tracked YouTube channel or creator.',
  category: 'Creator/content category used for filtering and context.',
  subscribers: 'Latest subscriber count when available from YouTube metadata.',
  'tracked?': 'Whether this channel is enabled for ongoing monitoring.',
  videos: 'Number of videos stored or analyzed for this creator.',
  mentions: 'Number of asset mentions detected for this creator.',
  'win 30d': 'Share of measurable mentions that were favorable 30 days after the mention.',
  'last synced': 'Most recent metadata or video sync timestamp for the channel.',
  actions: 'Available operations for this row.',
  'disclosure lag': 'Days between a politician trade and the public disclosure filing.',
  'copy score': 'Explainable 0-100 score estimating whether a disclosed trade is worth copying after lag, quality, history, and relevance checks.',
  dossiers: 'Entity profile pages with history, evidence, scores, and related context.',
}

function normalizeDefinitionKey(label) {
  return String(label || '')
    .replace(/\s+-\s+.*$/, '')
    .replace(/\s+\(.+\)$/, (match) => match.toLowerCase() === ' (d)' ? match : '')
    .trim()
    .toLowerCase()
}

export function definitionFor(label, override) {
  if (override) return override
  const key = normalizeDefinitionKey(label)
  return TERM_DEFINITIONS[key]
}

export function DefinitionLabel({ children, definition }) {
  const text = typeof children === 'string' ? children : ''
  const copy = definitionFor(text, definition)
  if (!copy) return children
  return (
    <span className="intel-definition" tabIndex={0} aria-label={`${text}: ${copy}`}>
      {children}
      <span className="intel-definition-popover" role="tooltip">{copy}</span>
    </span>
  )
}

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
            {title && <h2><DefinitionLabel>{title}</DefinitionLabel></h2>}
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
      <div className="intel-metric-label"><DefinitionLabel>{label}</DefinitionLabel></div>
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

export function AssetTicker({ symbol, name, investOrigin, direction = 'buy' }) {
  return (
    <span className="intel-ticker" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
      {symbol || '-'}{name ? <small>{name}</small> : null}
      {symbol && symbol !== '-' && (
        <InvestButton
          ticker={symbol}
          direction={direction}
          origin={investOrigin || { kind: 'intel', surface: 'asset-ticker' }}
        />
      )}
    </span>
  )
}

export function ScoreGauge({ label, value, tone = 'neutral', helper }) {
  const n = clampScore(value)
  return (
    <div className={`intel-score tone-${tone}`}>
      <div className="intel-score-top">
        <span><DefinitionLabel>{label}</DefinitionLabel></span>
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
        <AssetTicker symbol={assetSymbol} name={assetName} direction={direction === 'sell' || direction === 'bearish' ? 'sell' : 'buy'} investOrigin={{ kind: 'signal', surface: 'signal-card' }} />
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
              <span><DefinitionLabel>{stat.label}</DefinitionLabel></span>
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
              <th key={column.key} className={column.numeric ? 'is-numeric' : ''}>
                <DefinitionLabel definition={column.definition}>{column.label}</DefinitionLabel>
              </th>
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
