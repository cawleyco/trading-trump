import { useEffect, useState } from 'react'
import Dashboard from './views/Dashboard.jsx'
import Backtest from './views/Backtest.jsx'
import Politicians from './views/Politicians.jsx'
import Trades from './views/Trades.jsx'
import SignalLog from './views/SignalLog.jsx'
import Influence from './views/Influence.jsx'
import StatusBar from './components/StatusBar.jsx'

const VIEWS = {
  dashboard: ['Dashboard', Dashboard],
  trades: ['Trades', Trades],
  backtest: ['Backtesting', Backtest],
  politicians: ['Politicians', Politicians],
  influence: ['Influence Signals', Influence],
  log: ['Signal Log', SignalLog],
}

const VIEW_PATHS = {
  dashboard: '/',
  trades: '/app/trades',
  backtest: '/app/backtests',
  politicians: '/app/politicians',
  influence: '/app/influence/youtube',
  log: '/app/signals',
}

function viewFromPath(path) {
  if (path.startsWith('/app/influence')) return 'influence'
  if (path.startsWith('/app/trades')) return 'trades'
  if (path.startsWith('/app/backtests')) return 'backtest'
  if (path.startsWith('/app/politicians')) return 'politicians'
  if (path.startsWith('/app/signals')) return 'log'
  return 'dashboard'
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

  const navigate = (key) => {
    window.history.pushState({}, '', VIEW_PATHS[key])
    setPath(window.location.pathname)
  }

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '0 20px 60px' }}>
      <StatusBar />
      <nav style={{ display: 'flex', gap: 8, margin: '16px 0 24px' }}>
        {Object.entries(VIEWS).map(([key, [label]]) => (
          <button
            key={key}
            onClick={() => navigate(key)}
            style={view === key ? { borderColor: '#6366f1', background: '#26283a' } : {}}
          >
            {label}
          </button>
        ))}
      </nav>
      <View path={path} />
    </div>
  )
}
