import StatusBar from '../StatusBar.jsx'
import LlmUsageChip from '../LlmUsageChip.jsx'
import { useTheme } from '../../ThemeContext.jsx'

const NAV_GROUPS = [
  {
    label: 'YOUTUBE ANALYSIS',
    items: [
      { key: 'youtube-dashboard', label: 'Dashboard', path: '/app/influence/youtube', icon: 'YT' },
      { key: 'youtube-channels', label: 'Channels', path: '/app/influence/youtube/channels', icon: 'CH' },
      { key: 'youtube-videos', label: 'Videos', path: '/app/influence/youtube/videos', icon: 'VI' },
      { key: 'youtube-mentions', label: 'Mentions', path: '/app/influence/youtube/mentions', icon: 'ME' },
      { key: 'youtube-narratives', label: 'Narratives', path: '/app/influence/youtube/narratives', icon: 'NA' },
      { key: 'youtube-signals', label: 'Signals', path: '/app/influence/youtube/signals', icon: 'SG' },
      { key: 'youtube-backtests', label: 'Backtests', path: '/app/influence/youtube/backtests', icon: 'BT' },
    ],
  },
  {
    label: 'TRADING',
    items: [
      { key: 'active-trades', label: 'Active Trades', path: '/app/trading/active', icon: 'AT' },
      { key: 'trade-history', label: 'Trade History', path: '/app/trading/history', icon: 'TH' },
      { key: 'performance', label: 'Performance', path: '/app/trading/performance', icon: 'PF' },
      { key: 'approvals', label: 'Approvals', path: '/app/approvals', icon: 'AP' },
      { key: 'strategies', label: 'Strategies', path: '/app/strategies', icon: 'ST' },
    ],
  },
  {
    label: 'RESEARCH',
    items: [
      { key: 'intel', label: 'Intel', path: '/app/intel', icon: 'IN' },
      { key: 'congressional-trades', label: 'Congressional Trades', path: '/app/research/congress-trades', icon: 'CT' },
      { key: 'politicians', label: 'Politicians', path: '/app/influence/politicians', icon: 'PO' },
      { key: 'assets', label: 'Assets', path: '/app/assets', icon: 'AS', enabled: true },
      { key: 'calendar', label: 'Calendar', path: '/app/calendar', icon: 'CA' },
      { key: 'backtests', label: 'Backtests', path: '/app/backtests', icon: 'BT' },
      { key: 'research', label: 'Research', path: '/app/research', icon: 'RS', enabled: false },
    ],
  },
  {
    label: 'SYSTEM',
    items: [
      { key: 'overview', label: 'System Overview', path: '/app/overview', icon: 'OV' },
      { key: 'signals', label: 'Signal Log', path: '/app/signals', icon: 'SL' },
      { key: 'alerts', label: 'Alerts', path: '/app/alerts', icon: 'AL' },
      { key: 'guide', label: 'Guide', path: '/app/guide', icon: 'GD' },
      { key: 'data-sources', label: 'Data Sources', path: '/app/data-sources', icon: 'DS', enabled: false },
      { key: 'settings', label: 'Settings', path: '/app/settings', icon: 'SE', enabled: false },
    ],
  },
]

export default function AppShell({ path, onNavigate, children }) {
  const context = moduleContext(path)
  const { theme, setTheme, themes } = useTheme()
  return (
    <div className="intel-shell">
      <aside className="intel-sidebar">
        <button type="button" className="intel-brand" onClick={() => onNavigate('/app/influence/youtube')}>
          <span className="intel-brand-mark">PI</span>
          <span>
            <strong>Influence Intel</strong>
            <small>Intelligence Terminal</small>
          </span>
        </button>
        <nav className="intel-nav" aria-label="Primary">
          {NAV_GROUPS.map((group) => (
            <div key={group.label} className="intel-nav-group">
              <div className="intel-nav-label">{group.label}</div>
              {group.items.map((item) => (
                <NavItem key={item.key} item={item} path={path} onNavigate={onNavigate} />
              ))}
            </div>
          ))}
        </nav>
      </aside>
      <div className="intel-workspace">
        <header className="intel-topbar">
          <div className="intel-command-search">
            <span>⌘</span>
            <input placeholder="Search signals, assets, creators..." aria-label="Search signals, assets, creators" />
          </div>
          <div className="intel-topbar-context">
            <span>{context}</span>
            <span className="intel-live-dot" />
            <span>Data live: local</span>
            <LlmUsageChip />
            <select
              className="intel-theme-select"
              aria-label="Theme"
              value={theme}
              onChange={(e) => setTheme(e.target.value)}
            >
              {themes.map((t) => (
                <option key={t.id} value={t.id}>{t.label}</option>
              ))}
            </select>
            <button type="button" disabled>Alerts</button>
            <button type="button" className="intel-user-button">Analyst</button>
          </div>
        </header>
        <main className="intel-main">
          <StatusBar />
          {children}
          <footer className="intel-disclaimer">
            Research tool. Not investment advice. Congressional disclosure data is delayed 30–45+ days and may
            contain errors. Built for personal use — see <code>docs/CAVEATS.md</code>.
          </footer>
        </main>
      </div>
    </div>
  )
}

function NavItem({ item, path, onNavigate }) {
  const active = isActive(path, item.path)
  const disabled = item.enabled === false
  return (
    <div>
      <button
        type="button"
        className={`intel-nav-item ${active ? 'is-active' : ''} ${disabled ? 'is-disabled' : ''}`.trim()}
        onClick={() => !disabled && onNavigate(item.path)}
        disabled={disabled}
      >
        <span className="intel-nav-icon">{item.icon}</span>
        <span>{item.label}</span>
        {disabled && <small>soon</small>}
      </button>
      {item.children && isInfluencePath(path) && (
        <div className="intel-nav-children">
          {item.children.map((child) => (
            <button
              type="button"
              key={child.key}
              className={`${isActive(path, child.path) ? 'is-active' : ''} ${child.enabled === false ? 'is-disabled' : ''}`.trim()}
              onClick={() => child.enabled !== false && onNavigate(child.path)}
              disabled={child.enabled === false}
            >
              {child.label}
              {child.enabled === false && <small>soon</small>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function isActive(path, itemPath) {
  if (itemPath === '/app/influence/youtube') return path === '/' || path === '/app' || path === '/app/influence/youtube'
  if (itemPath === '/app/overview') return path === '/app/overview'
  return path === itemPath || path.startsWith(`${itemPath}/`)
}

function isInfluencePath(path) {
  return path.startsWith('/app/influence')
}

function moduleContext(path) {
  if (path.startsWith('/app/influence/youtube')) return 'YouTube Influence'
  if (path.startsWith('/app/influence/politicians')) return 'Politician Dossiers'
  if (path.startsWith('/app/signals')) return 'Normalized Signals'
  if (path.startsWith('/app/backtests')) return 'Backtest Lab'
  if (path.startsWith('/app/strategies')) return 'Strategy Review'
  if (path.startsWith('/app/trading/active')) return 'Active Trades'
  if (path.startsWith('/app/trading/history')) return 'Trade History'
  if (path.startsWith('/app/trading/performance')) return 'Performance Analytics'
  if (path.startsWith('/app/research/congress-trades') || path.startsWith('/app/trades')) return 'Congressional Trades'
  if (path.startsWith('/app/guide')) return 'Guide'
  return 'Overview'
}
