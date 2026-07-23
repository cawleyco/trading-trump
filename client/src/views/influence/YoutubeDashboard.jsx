import { useEffect, useState } from 'react'
import { api } from '../../api.js'
import { StatCard } from './InfluenceLayout.jsx'
import { card, muted, navigate } from './ui.js'
import { DefinitionLabel, SectionPanel, SignalCard } from '../../components/intel/components.jsx'

export default function YoutubeDashboard() {
  const [stats, setStats] = useState(null)
  const [signals, setSignals] = useState([])
  const [collection, setCollection] = useState(null)
  const [queuing, setQueuing] = useState(false)
  const [queueMessage, setQueueMessage] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    api.youtubeDashboard().then(setStats).catch((e) => setError(e.message))
    api.influenceSignals('youtube').then(setSignals).catch(() => {})
    api.youtubeCollectionPlan().then(setCollection).catch(() => {})
  }, [])

  const queuePriorityBackfill = async () => {
    setQueuing(true)
    setQueueMessage(null)
    try {
      const result = await api.queueYoutubeCollectionPlan({ maxChannels: 5, maxVideos: 500, maxVideosPerChannel: 100 })
      setCollection(result.plan)
      setQueueMessage(`Queued ${result.queued} historical videos across ${result.results.filter((r) => !r.error).length} channels.`)
    } catch (err) {
      setQueueMessage(err.message)
    } finally {
      setQueuing(false)
    }
  }

  if (error) return <section style={card}><h3>YouTube Dashboard</h3><p style={{ color: 'var(--color-bearish)' }}>{error}</p></section>
  if (!stats) return <p className="intel-muted">Loading Influence Signals...</p>

  return (
    <div>
      <div className="intel-grid" style={{ marginBottom: 16 }}>
        <StatCard label="Videos analyzed today" value={stats.videosAnalyzedToday} />
        <StatCard label="New asset mentions" value={stats.newAssetMentions} />
        <StatCard label="Bullish high-quality" value={stats.highQualityBullishMentions} />
        <StatCard label="Bearish high-quality" value={stats.highQualityBearishMentions} />
        <StatCard label="High pump-risk" value={stats.highPumpRiskMentions} />
      </div>

      <div className="intel-dashboard-grid">
        <div>
      <SectionPanel title="Recent Creator Signals" description="Strong mentions need historical follow-through before they become copy candidates.">
        {signals.length === 0 ? (
          <p style={muted}>No influence research signals yet. Live trading integration remains disabled.</p>
        ) : (
          <div className="intel-signal-list">
            {signals.slice(0, 8).map((s) => (
              <SignalCard
                key={s.id}
                id={s.id}
                title={s.explanation || `${s.symbol} creator mention`}
                sourceType="youtube"
                sourceName={s.channel_title || 'YouTube'}
                assetSymbol={s.symbol}
                direction={s.direction || 'neutral'}
                action={s.suggested_action || 'manual_review'}
                actionabilityScore={s.actionability_score ?? s.mention_quality_score ?? 50}
                confidenceScore={s.confidence_score ?? 60}
                riskScore={s.pump_risk_score ?? 35}
                historicalReturnLabel={s.historical_return_label || 'Edge not confirmed'}
                summary={s.explanation || 'Signal detected. Creator history and transcript evidence should be reviewed.'}
                timestamp={s.created_at}
                evidenceCount={s.evidence_count ?? 1}
              />
            ))}
          </div>
        )}
      </SectionPanel>

      <SectionPanel title="Assets Trending Across YouTube" description="High attention is not the same thing as alpha.">
        {stats.trendingAssets.length === 0 ? (
          <p style={muted}>No detected mentions yet.</p>
        ) : (
          <table>
            <thead><tr><th>Asset</th><th>Name</th><th><DefinitionLabel>Mentions</DefinitionLabel></th></tr></thead>
            <tbody>
              {stats.trendingAssets.map((a) => (
                <tr key={a.id}><td style={{ fontFamily: 'var(--font-mono)' }}>{a.symbol}</td><td>{a.canonical_name}</td><td>{a.mentions}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </SectionPanel>
        </div>

        <div>
      <SectionPanel title="Tracked YouTube Creators" description="Start with manually added finance/crypto channels, then sync metadata when `YOUTUBE_API_KEY` is configured.">
        <button onClick={() => navigate('/app/influence/youtube/channels')}>Manage channels</button>
      </SectionPanel>

      <SectionPanel title="Data Quality" description="Transcript coverage, creator history, and sample size determine confidence.">
        {!collection ? <p className="intel-muted">Loading collection coverage…</p> : (
          <>
            <p className="intel-muted">
              {collection.totals.transcriptVideos}/{collection.totals.knownVideos} known videos have transcripts ·{' '}
              {collection.totals.matureDirectionalSignals}/{collection.totals.directionalSignals} directional signals have 90-day maturity.
            </p>
            <p className="intel-muted">
              Target: {collection.targets.videosPerChannel} videos and {collection.targets.historyMonths} months per creator · {collection.eligibleChannels} channels still eligible for collection.
            </p>
            <button onClick={queuePriorityBackfill} disabled={queuing || collection.eligibleChannels === 0}>
              {queuing ? 'Queuing…' : 'Queue priority backfill'}
            </button>
            {queueMessage && <p className="intel-muted">{queueMessage}</p>}
          </>
        )}
      </SectionPanel>
        </div>
      </div>

      {collection && (
        <SectionPanel title="Historical Collection Priorities" description="Direct-call channels with the largest video and history gaps are queued first; processing remains oldest-first and bounded per poll cycle.">
          <div className="intel-table-wrap">
            <table className="intel-table">
              <thead><tr><th>Priority</th><th>Channel</th><th>Known</th><th>Transcripts</th><th>Queued</th><th>Oldest</th><th>Gap</th><th>Status</th></tr></thead>
              <tbody>
                {collection.channels.slice(0, 12).map((row) => (
                  <tr key={row.id}>
                    <td>{row.priorityScore}</td>
                    <td>{row.title}</td>
                    <td>{row.known_videos}</td>
                    <td>{Math.round(row.transcriptCoverage * 100)}%</td>
                    <td>{row.queued_videos}</td>
                    <td>{row.oldest_known_video?.slice(0, 10) || '—'}</td>
                    <td>{row.videoGap}</td>
                    <td>{row.eligible ? 'ready' : row.blockedReasons.join(', ') || 'target met'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionPanel>
      )}
    </div>
  )
}
