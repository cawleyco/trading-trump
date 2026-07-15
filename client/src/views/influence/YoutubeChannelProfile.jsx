import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api.js'
import { PumpRiskBadge } from './InfluenceLayout.jsx'
import { card, muted, navigate } from './ui.js'
import { DossierHeader, SectionPanel } from '../../components/intel/components.jsx'

export default function YoutubeChannelProfile({ channelId }) {
  const [channel, setChannel] = useState(null)
  const [videos, setVideos] = useState([])
  const [mentions, setMentions] = useState([])
  const [backfillStatus, setBackfillStatus] = useState(null)
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)

  const refresh = useCallback(() => {
    api.youtubeChannel(channelId).then(setChannel).catch((e) => setError(e.message))
    api.youtubeVideos(channelId).then(setVideos).catch(() => {})
    api.youtubeMentions({ channelId }).then(setMentions).catch(() => {})
    api.youtubeBackfillStatus(channelId).then(setBackfillStatus).catch(() => {})
  }, [channelId])
  useEffect(() => { refresh() }, [refresh])

  const recalc = async () => {
    setBusy('alpha')
    try {
      await api.recalculateYoutubeAlpha(channelId)
      refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(null)
    }
  }

  const backfill = async () => {
    setBusy('backfill')
    try {
      const result = await api.backfillYoutubeChannel(channelId, { maxVideos: 100 })
      setError(null)
      refresh()
      return result
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(null)
    }
  }

  // Compact drain-progress line from the per-status counts.
  const backfillSummary = (() => {
    const rows = backfillStatus?.statuses || []
    if (!rows.length) return null
    const total = (pred) => rows.filter(pred).reduce((s, r) => s + r.count, 0)
    const pending = total((r) => r.ingestion_status === 'backfill_pending')
    const ingested = total((r) => r.ingestion_status === 'ingested')
    const failed = total((r) => r.ingestion_status === 'ingest_failed')
    return `${ingested} ingested · ${pending} queued for backfill · ${failed} failed/no captions`
  })()

  if (error) return <section style={card}><p style={{ color: 'var(--color-bearish)' }}>{error}</p></section>
  if (!channel) return <p className="intel-muted">Loading channel...</p>
  const alpha = channel.alpha?.[0]

  return (
    <div>
      <button onClick={() => navigate('/app/influence/youtube/channels')} style={{ marginBottom: 10 }}>Back to channels</button>
      <DossierHeader
        entityType="creator"
        name={channel.title}
        subtitle={channel.description || 'No description stored.'}
        badges={[
          { label: channel.category || 'CREATOR', tone: 'info' },
          {
            label: (alpha?.label || 'insufficient_data').replace(/_/g, ' ').toUpperCase(),
            tone: alpha?.label === 'follow' ? 'good' : alpha?.label === 'fade' ? 'bad' : alpha?.label === 'neutral' ? 'info' : 'warning',
          },
        ]}
        stats={[
          { label: 'Subscribers', value: channel.subscriber_count ?? '-' },
          { label: 'Videos analyzed', value: videos.length },
          { label: 'Mentions', value: mentions.length },
          { label: 'Measurable (30d)', value: alpha?.measurable_mentions ?? 0 },
          { label: 'Alpha score', value: alpha?.alpha_score == null ? '-' : alpha.alpha_score.toFixed(0) },
          { label: 'Pump-dump rate', value: alpha?.pump_dump_rate == null ? '-' : `${(alpha.pump_dump_rate * 100).toFixed(0)}%` },
        ]}
      />
      <SectionPanel
        title="Creator Alpha"
        description={alpha?.alpha_basis
          ? `Basis: ${alpha.alpha_basis}. Alpha stays null until the sample clears the minimum — an unknown creator is not a good one.`
          : 'No alpha computed yet — sync videos, analyze mentions, then recalculate.'}
      >
        {alpha?.label && alpha.label !== 'insufficient_data' && (
          <p style={{ margin: '4px 0 0' }}>
            Avg 30d return {alpha.avg_return_30d == null ? '—' : `${alpha.avg_return_30d.toFixed(1)}%`}
            {' · '}win rate {alpha.win_rate_30d == null ? '—' : `${(alpha.win_rate_30d * 100).toFixed(0)}%`}
            {' over '}{alpha.measurable_mentions} measurable mentions
          </p>
        )}
        <button onClick={recalc} disabled={busy === 'alpha'} style={{ marginTop: 12 }}>
          {busy === 'alpha' ? 'Recalculating...' : 'Recalculate creator alpha'}
        </button>
      </SectionPanel>

      <SectionPanel title="Recent Videos" description="Transcript status determines whether mentions can be audited.">
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
          <button onClick={backfill} disabled={busy === 'backfill'} title="Queue up to 100 older videos; the poller ingests them a few per cycle">
            {busy === 'backfill' ? 'Queuing…' : 'Backfill history (100 videos)'}
          </button>
          {backfillSummary && <span style={muted}>{backfillSummary}</span>}
        </div>
        {videos.length === 0 ? <p style={muted}>No videos synced yet.</p> : (
          <table>
            <thead><tr><th>Published</th><th>Title</th><th>Transcript</th><th>Analysis</th><th></th></tr></thead>
            <tbody>
              {videos.slice(0, 20).map((v) => (
                <tr key={v.id}>
                  <td>{v.published_at}</td>
                  <td>{v.title}</td>
                  <td>{v.transcript_status}</td>
                  <td>{v.analysis_status}</td>
                  <td><button onClick={() => navigate(`/app/influence/youtube/videos/${v.id}`)}>Open</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SectionPanel>

      <SectionPanel title="Mention History" description="Detected asset mentions with quality, direction, and pump-risk context.">
        {mentions.length === 0 ? <p style={muted}>No detected mentions yet.</p> : (
          <table>
            <thead><tr><th>Asset</th><th>Direction</th><th>Quality</th><th>Pump risk</th><th>Summary</th></tr></thead>
            <tbody>
              {mentions.slice(0, 30).map((m) => (
                <tr key={m.id}>
                  <td>{m.symbol}</td>
                  <td>{m.direction || '—'}</td>
                  <td>{m.mention_quality_score == null ? '—' : m.mention_quality_score.toFixed(0)}</td>
                  <td><PumpRiskBadge score={m.pump_risk_score} /></td>
                  <td style={muted}>{m.summary || m.mention_text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SectionPanel>
    </div>
  )
}
