import { useEffect, useState } from 'react'
import { api } from '../api.js'
import { SignalTable } from './Dashboard.jsx'

export default function SignalLog() {
  const [signals, setSignals] = useState([])

  useEffect(() => {
    api.signals(500).then(setSignals).catch(() => {})
  }, [])

  return (
    <section>
      <h3>Full Signal & Decision Log</h3>
      <p style={{ color: '#a1a1aa', fontSize: '0.9em' }}>
        Every signal the bot generated, including rejected ones, with the risk manager's reasoning.
      </p>
      <SignalTable signals={signals} />
    </section>
  )
}
