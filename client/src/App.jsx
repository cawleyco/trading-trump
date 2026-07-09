import { useEffect, useState } from 'react'
import Dashboard from './views/Dashboard.jsx'
import Backtest from './views/Backtest.jsx'
import Politicians from './views/Politicians.jsx'
import Trades from './views/Trades.jsx'
import Intel from './views/Intel.jsx'
import Calendar from './views/Calendar.jsx'
import Strategies from './views/Strategies.jsx'
import Approvals from './views/Approvals.jsx'
import SignalLog from './views/SignalLog.jsx'
import Alerts from './views/Alerts.jsx'
import Influence from './views/Influence.jsx'
import AppShell from './components/intel/AppShell.jsx'
import { EmptyState, PageHeader, SectionPanel } from './components/intel/components.jsx'

const VIEWS = {
  overview: ['Overview', Dashboard],
  trades: ['Trades', Trades],
  intel: ['Intel', Intel],
  calendar: ['Calendar', Calendar],
  strategies: ['Strategies', Strategies],
  approvals: ['Approvals', Approvals],
  backtest: ['Backtesting', Backtest],
  politicians: ['Politicians', Politicians],
  influence: ['Influence Signals', Influence],
  signals: ['Signals', SignalLog],
  assets: ['Assets', AssetsPlaceholder],
  research: ['Research', ResearchPlaceholder],
  alerts: ['Alerts', Alerts],
  dataSources: ['Data Sources', DataSourcesPlaceholder],
  settings: ['Settings', SettingsPlaceholder],
}

const VIEW_PATHS = {
  overview: '/app/overview',
  trades: '/app/trades',
  intel: '/app/intel',
  calendar: '/app/calendar',
  strategies: '/app/strategies',
  approvals: '/app/approvals',
  backtest: '/app/backtests',
  politicians: '/app/influence/politicians',
  influence: '/app/influence/youtube',
  signals: '/app/signals',
  assets: '/app/assets',
  research: '/app/research',
  alerts: '/app/alerts',
  dataSources: '/app/data-sources',
  settings: '/app/settings',
}

function viewFromPath(path) {
  if (path === '/' || path === '/app' || path.startsWith('/app/overview')) return 'overview'
  if (path.startsWith('/app/influence/politicians') || path.startsWith('/app/politicians')) return 'politicians'
  if (path.startsWith('/app/influence')) return 'influence'
  if (path.startsWith('/app/trades')) return 'trades'
  if (path.startsWith('/app/intel')) return 'intel'
  if (path.startsWith('/app/calendar')) return 'calendar'
  if (path.startsWith('/app/strategies')) return 'strategies'
  if (path.startsWith('/app/approvals')) return 'approvals'
  if (path.startsWith('/app/backtests')) return 'backtest'
  if (path.startsWith('/app/signals')) return 'signals'
  if (path.startsWith('/app/assets')) return 'assets'
  if (path.startsWith('/app/research')) return 'research'
  if (path.startsWith('/app/alerts')) return 'alerts'
  if (path.startsWith('/app/data-sources')) return 'dataSources'
  if (path.startsWith('/app/settings')) return 'settings'
  return 'overview'
}

export default function App() {
  const [path, setPath] = useState(window.location.pathname)
  const view = viewFromPath(path)
  const View = VIEWS[view][1]

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname)
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const navigate = (target) => {
    const nextPath = VIEW_PATHS[target] || target
    window.history.pushState({}, '', nextPath)
    setPath(window.location.pathname)
  }

  return (
    <AppShell path={path} onNavigate={navigate}>
      <View path={path} />
    </AppShell>
  )
}

function AssetsPlaceholder() {
  return (
    <>
      <PageHeader
        eyebrow="Asset intelligence"
        title="Assets"
        description="A convergence view for politician trades, creator mentions, public narratives, and risk warnings."
        meta="Future module · data model ready for cross-source timelines"
      />
      <SectionPanel title="Asset Intelligence" description="Edge not confirmed until source trails and backtests are attached.">
        <EmptyState
          title="Asset pages are staged."
          body="This section is reserved for cross-source asset timelines, exposure scoring, and public influence summaries."
        />
      </SectionPanel>
    </>
  )
}

function ResearchPlaceholder() {
  return <Placeholder title="Research" description="Saved notes, evidence trails, and analyst review queues will live here." />
}

function DataSourcesPlaceholder() {
  return <Placeholder title="Data Sources" description="Source health, sync freshness, and coverage warnings will be consolidated here." />
}

function SettingsPlaceholder() {
  return <Placeholder title="Settings" description="Terminal preferences, source modules, and risk controls will be managed here." />
}

function Placeholder({ title, description }) {
  return (
    <>
      <PageHeader eyebrow="Coming soon" title={title} description={description} meta="Visually present · module disabled" />
      <SectionPanel>
        <EmptyState title="Coming soon" body="Manual review recommended before enabling this module in live workflows." />
      </SectionPanel>
    </>
  )
}
