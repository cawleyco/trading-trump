import StatusBar from '../StatusBar.jsx'

const NAV_GROUPS = [
  {
    label: 'INTELLIGENCE',
    items: [
      { key: 'overview', label: 'Overview', path: '/app/overview', icon: 'OV' },
      { key: 'intel', label: 'Intel', path: '/app/intel', icon: 'IN' },
      { key: 'signals', label: 'Signals', path: '/app/signals', icon: 'SG' },
      {
        key: 'influence',
        label: 'Influence',
        path: '/app/influence',
        icon: 'IF',
        children: [
          { key: 'politicians', label: 'Politicians', path: '/app/influence/politicians', enabled: true },
          { key: 'youtube', label: 'YouTube', path: '/app/influence/youtube', enabled: true },
          { key: 'x', label: 'X / Twitter', path: '/app/influence/x', enabled: false },
          { key: 'reddit', label: 'Reddit', path: '/app/influence/reddit', enabled: false },
          { key: 'podcasts', label: 'Podcasts', path: '/app/influence/podcasts', enabled: false },
          { key: 'newsletters', label: 'Newsletters', path: '/app/influence/newsletters', enabled: false },
          { key: 'sec', label: 'SEC Filings', path: '/app/influence/sec-filings', enabled: false },
        ],
      },
      { key: 'assets', label: 'Assets', path: '/app/assets', icon: 'AS', enabled: false },
    ],
  },
  {
    label: 'ANALYSIS',
    items: [
      { key: 'backtests', label: 'Backtests', path: '/app/backtests', icon: 'BT' },
      { key: 'strategies', label: 'Strategies', path: '/app/strategies', icon: 'ST' },
      { key: 'research', label: 'Research', path: '/app/research', icon: 'RS', enabled: false },
    ],
  },
  {
    label: 'SYSTEM',
    items: [
      { key: 'alerts', label: 'Alerts', path: '/app/alerts', icon: 'AL' },
      { key: 'data-sources', label: 'Data Sources', path: '/app/data-sources', icon: 'DS', enabled: false },
      { key: 'settings', label: 'Settings', path: '/app/settings', icon: 'SE', enabled: false },
    ],
  },
]

export default function AppShell({ path, onNavigate, children }) {
  const context = moduleContext(path)
  return (
    <div className="intel-shell">
      <aside className="intel-sidebar">
        <button type="button" className="intel-brand" onClick={() => onNavigate('/app/overview')}>
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
  if (itemPath === '/app/overview') return path === '/' || path === '/app' || path === '/app/overview'
  if (itemPath === '/app/influence') return path.startsWith('/app/influence')
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
  return 'Overview'
}
