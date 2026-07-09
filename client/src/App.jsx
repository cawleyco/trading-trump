import { useState } from 'react'
import Dashboard from './views/Dashboard.jsx'
import Backtest from './views/Backtest.jsx'
import Politicians from './views/Politicians.jsx'
import SignalLog from './views/SignalLog.jsx'
import StatusBar from './components/StatusBar.jsx'

const VIEWS = {
  dashboard: ['Dashboard', Dashboard],
  backtest: ['Backtesting', Backtest],
  politicians: ['Politicians', Politicians],
  log: ['Signal Log', SignalLog],
}

export default function App() {
  const [view, setView] = useState('dashboard')
  const View = VIEWS[view][1]

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '0 20px 60px' }}>
      <StatusBar />
      <nav style={{ display: 'flex', gap: 8, margin: '16px 0 24px' }}>
        {Object.entries(VIEWS).map(([key, [label]]) => (
          <button
            key={key}
            onClick={() => setView(key)}
            style={view === key ? { borderColor: '#6366f1', background: '#26283a' } : {}}
          >
            {label}
          </button>
        ))}
      </nav>
      <View />
    </div>
  )
}
