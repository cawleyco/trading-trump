import { useEffect, useState } from 'react'
import { api } from '../api.js'
import { PageHeader, SectionPanel, EmptyState } from '../components/intel/components.jsx'
import { InvestButton } from '../components/InvestButton.jsx'

const KIND_META = {
  congress: { label: 'CONGRESS', color: 'var(--color-accent, #d4a017)' },
  youtube: { label: 'YOUTUBE', color: 'var(--color-bullish)' },
  trump: { label: 'TRUMP', color: 'var(--color-warning, #e0a030)' },
  calendar: { label: 'CALENDAR', color: 'var(--color-text-muted)' },
}

const muted = { color: 'var(--color-text-muted)' }

export default function Assets() {
  const [ticker, setTicker] = useState('')
  const [days, setDays] = useState(90)
  const [timeline, setTimeline] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const load = async (symbol) => {
    const t = String(symbol || ticker).trim().toUpperCase()
    if (!t) return
    setBusy(true)
    setError(null)
    try {
      setTimeline(await api.assetTimeline(t, { days }))
    } catch (err) {
      setError(err.message)
      setTimeline(null)
    } finally {
      setBusy(false)
    }
  }

  // Deep links: /app/assets?ticker=TSLA
  useEffect(() => {
    const fromQuery = new URLSearchParams(window.location.search).get('ticker')
    if (fromQuery) {
      setTicker(fromQuery.toUpperCase())
      load(fromQuery)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <PageHeader
        eyebrow="Asset intelligence"
        title="Assets"
        description="One ticker, every source: congress trades, finfluencer mentions, Trump posts, and political calendar events on a single timeline."
        meta="Confluence windows highlight when independent sources agree"
      />
      <SectionPanel title="Cross-Source Timeline" description="Search a ticker to merge every tracked signal source into one chronological trail.">
        <form
          onSubmit={(e) => { e.preventDefault(); load() }}
          style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 14 }}
        >
          <label style={{ display: 'grid', gap: 4, ...muted, fontSize: '0.85em' }}>
            Ticker
            <input
              value={ticker}
              onChange={(e) => setTicker(e.target.value.toUpperCase())}
              placeholder="TSLA"
              style={{ width: 120, fontFamily: 'var(--font-mono)' }}
            />
          </label>
          <label style={{ display: 'grid', gap: 4, ...muted, fontSize: '0.85em' }}>
            Lookback
            <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
              <option value={180}>180 days</option>
              <option value={365}>1 year</option>
            </select>
          </label>
          <button disabled={busy || !ticker.trim()}>{busy ? 'Loading…' : 'Load timeline'}</button>
          {timeline && (
            <InvestButton
              ticker={timeline.ticker}
              origin={{ kind: 'assets', surface: 'asset-timeline' }}
            />
          )}
        </form>
        {error && <p style={{ color: 'var(--color-bearish)' }}>{error}</p>}

        {!timeline && !error && (
          <EmptyState title="No ticker loaded" body="Search any ticker to see its cross-source signal history." />
        )}

        {timeline && (
          <>
            <p style={muted}>
              <strong style={{ color: 'var(--color-text)' }}>{timeline.ticker}</strong>
              {timeline.meta?.name ? ` — ${timeline.meta.name}` : ''}
              {timeline.meta?.sector ? ` (${timeline.meta.sector})` : ''}
              {' · '}
              {Object.entries(timeline.counts).map(([k, n]) => `${n} ${k}`).join(' · ') || 'no events in range'}
            </p>

            {timeline.confluenceWindows.length > 0 && (
              <div style={{ margin: '10px 0', padding: '8px 12px', border: '1px solid var(--color-border)', borderLeft: '3px solid var(--color-bullish)' }}>
                <strong>Confluence detected:</strong>{' '}
                {timeline.confluenceWindows.map((w, i) => (
                  <span key={i} style={{ marginRight: 12 }}>
                    {w.start} → {w.end} ({w.sources.join(' + ')}, {w.eventCount} events)
                  </span>
                ))}
              </div>
            )}

            {timeline.events.length === 0 ? (
              <EmptyState title="Quiet ticker" body={`No tracked source touched ${timeline.ticker} in the last ${timeline.days} days.`} />
            ) : (
              <div style={{ display: 'grid', gap: 0 }}>
                {timeline.events.map((e) => (
                  <div
                    key={`${e.kind}-${e.id}`}
                    style={{
                      display: 'flex',
                      gap: 12,
                      padding: '8px 10px',
                      borderLeft: `3px solid ${e.confluent ? 'var(--color-bullish)' : 'var(--color-border)'}`,
                      background: e.confluent ? 'color-mix(in srgb, var(--color-bullish) 6%, transparent)' : 'transparent',
                    }}
                  >
                    <span style={{ ...muted, fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap', fontSize: '0.85em' }}>
                      {String(e.ts).slice(0, 10)}
                    </span>
                    <span style={{ color: KIND_META[e.kind]?.color, fontWeight: 600, fontSize: '0.8em', minWidth: 76 }}>
                      {KIND_META[e.kind]?.label || e.kind.toUpperCase()}
                    </span>
                    {e.direction && (
                      <span style={{ color: e.direction === 'bearish' ? 'var(--color-bearish)' : 'var(--color-bullish)', fontSize: '0.85em', minWidth: 56 }}>
                        {e.direction}
                      </span>
                    )}
                    <span style={{ flex: 1 }}>{e.summary}</span>
                    {e.score != null && (
                      <span style={{ ...muted, fontFamily: 'var(--font-mono)', fontSize: '0.85em' }} title="Source-native score">
                        {Math.round(e.score)}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </SectionPanel>
    </>
  )
}
