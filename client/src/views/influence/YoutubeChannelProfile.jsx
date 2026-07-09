import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api.js'
import { PumpRiskBadge } from './InfluenceLayout.jsx'
import { card, muted, navigate } from './ui.js'
import { DossierHeader, SectionPanel } from '../../components/intel/components.jsx'

export default function YoutubeChannelProfile({ channelId }) {
  const [channel, setChannel] = useState(null)
  const [videos, setVideos] = useState([])
  const [mentions, setMentions] = useState([])
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)

  const refresh = useCallback(() => {
    api.youtubeChannel(channelId).then(setChannel).catch((e) => setError(e.message))
    api.youtubeVideos(channelId).then(setVideos).catch(() => {})
    api.youtubeMentions({ channelId }).then(setMentions).catch(() => {})
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

  if (error) return <section style={card}><p style={{ color: '#fca5a5' }}>{error}</p></section>
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
          { label: alpha?.label || 'INSUFFICIENT DATA', tone: alpha?.alpha_score >= 70 ? 'good' : 'warning' },
        ]}
        stats={[
          { label: 'Subscribers', value: channel.subscriber_count ?? '-' },
          { label: 'Videos analyzed', value: videos.length },
          { label: 'Mentions', value: mentions.length },
          { label: 'Alpha score', value: alpha?.alpha_score == null ? '-' : alpha.alpha_score.toFixed(0) },
          { label: 'Pump risk', value: alpha?.pump_risk_score == null ? '-' : alpha.pump_risk_score.toFixed(0) },
        ]}
      />
      <SectionPanel title="Creator Alpha" description="Strong mention. Weak history still requires manual review.">
        <button onClick={recalc} disabled={busy === 'alpha'} style={{ marginTop: 12 }}>
          {busy === 'alpha' ? 'Recalculating...' : 'Recalculate creator alpha'}
        </button>
      </SectionPanel>

      <SectionPanel title="Recent Videos" description="Transcript status determines whether mentions can be audited.">
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
