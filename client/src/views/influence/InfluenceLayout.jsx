import { influenceModules } from '../../influence/modules.js'
import { card, muted, navigate } from './ui.js'

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
      <div style={{ marginBottom: 18 }}>
        <h2 style={{ marginBottom: 4 }}>Influence Signals</h2>
        <p style={{ ...muted, marginTop: 0 }}>
          Public figure market-intelligence modules. MVP source: {influenceModules[0].label}.
        </p>
      </div>
      <nav style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 18 }}>
        {tabs.map(([href, label]) => (
          <button
            key={href}
            onClick={() => navigate(href)}
            style={path === href ? { borderColor: '#6366f1', background: '#26283a' } : {}}
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
  return (
    <section style={{ ...card, minWidth: 180, flex: 1 }}>
      <div style={{ color: '#a1a1aa', fontSize: '0.8em' }}>{label}</div>
      <div style={{ fontSize: '1.7em', marginTop: 4 }}>{value ?? '—'}</div>
      {hint && <div style={{ ...muted, fontSize: '0.8em', marginTop: 4 }}>{hint}</div>}
    </section>
  )
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
