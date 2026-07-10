import { influenceModules } from '../../influence/modules.js'
import { MetricCard, PageHeader } from '../../components/intel/components.jsx'
import { navigate } from './ui.js'

export default function InfluenceLayout({ path, children }) {
  const tabs = [
    ['/app/influence/youtube', 'Overview'],
    ['/app/influence/youtube/channels', 'Channels'],
    ['/app/influence/youtube/videos', 'Videos'],
    ['/app/influence/youtube/mentions', 'Mentions'],
    ['/app/influence/youtube/backtests', 'Backtests'],
    ['/app/influence/youtube/signals', 'Signals'],
  ]
  return (
    <section>
      <PageHeader
        eyebrow="Influence / YouTube"
        helpSlug="youtube"
        title="YouTube Influence"
        description="Track creator mentions, sentiment, market impact, and realistic post-mention follow-through."
        meta={`MVP source: ${influenceModules[0].label} · Pump-risk elevated signals require review`}
      />
      <nav style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 18 }}>
        {tabs.map(([href, label]) => (
          <button
            key={href}
            onClick={() => navigate(href)}
            style={path === href ? { borderColor: 'var(--color-accent-primary)', background: 'rgba(245, 177, 76, 0.09)' } : {}}
          >
            {label}
          </button>
        ))}
      </nav>
      {children}
    </section>
  )
}

export function StatCard({ label, value, hint }) {
  return <MetricCard label={label} value={value ?? '-'} helper={hint} />
}

export function DirectionBadge({ direction }) {
  const color = direction === 'bullish' ? '#86efac' : direction === 'bearish' ? '#fca5a5' : '#e4e4e7'
  return <span style={{ color }}>{direction || 'unclassified'}</span>
}

export function PumpRiskBadge({ score }) {
  const n = Number(score || 0)
  const color = n >= 70 ? '#fca5a5' : n >= 40 ? '#fde68a' : '#86efac'
  return <span style={{ color }}>{Number.isFinite(n) ? n.toFixed(0) : '—'}</span>
}
