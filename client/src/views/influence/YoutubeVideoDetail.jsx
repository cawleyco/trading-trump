import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api.js'
import { DirectionBadge, PumpRiskBadge } from './InfluenceLayout.jsx'
import { card, muted, navigate } from './ui.js'

export default function YoutubeVideoDetail({ videoId }) {
  const [video, setVideo] = useState(null)
  const [transcript, setTranscript] = useState('')
  const [format, setFormat] = useState('plain_text')
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)

  const refresh = useCallback(() => api.youtubeVideo(videoId).then(setVideo).catch((e) => setError(e.message)), [videoId])
  useEffect(() => { refresh() }, [refresh])

  const upload = async () => {
    setBusy('upload')
    setError(null)
    try {
      await api.uploadYoutubeTranscript(videoId, { rawText: transcript, format })
      setTranscript('')
      refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(null)
    }
  }

  const analyze = async () => {
    setBusy('analyze')
    try {
      await api.analyzeYoutubeVideo(videoId)
      refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(null)
    }
  }

  const classify = async (mentionId) => {
    setBusy(`classify-${mentionId}`)
    try {
      await api.classifyYoutubeMention(mentionId)
      refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(null)
    }
  }

  const signalize = async () => {
    setBusy('signals')
    try {
      await api.generateYoutubeSignals(videoId)
      refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(null)
    }
  }

  if (error) return <section style={card}><p style={{ color: '#fca5a5' }}>{error}</p></section>
  if (!video) return <p>Loading video…</p>

  return (
    <div>
      <section style={card}>
        <button onClick={() => navigate('/app/influence/youtube/videos')} style={{ marginBottom: 10 }}>Back to videos</button>
        <h3>{video.title}</h3>
        <p style={muted}>{video.channel_title} · {video.published_at}</p>
        {video.thumbnail_url && <img src={video.thumbnail_url} alt="" style={{ maxWidth: 260, borderRadius: 8 }} />}
        <table style={{ marginTop: 12 }}>
          <tbody>
            <tr><td>Duration</td><td>{video.duration_seconds ?? '—'} sec</td></tr>
            <tr><td>Captions flag</td><td>{String(video.has_captions ?? 'unknown')}</td></tr>
            <tr><td>Paid product placement</td><td>{String(video.has_paid_product_placement ?? 'unknown')}</td></tr>
            <tr><td>Transcript status</td><td>{video.transcript_status}</td></tr>
            <tr><td>Analysis status</td><td>{video.analysis_status}</td></tr>
          </tbody>
        </table>
      </section>

      <section style={card}>
        <h3>Manual Transcript Upload</h3>
        <p style={muted}>Upload text, SRT, or VTT from an authorized/compliant source. The app does not scrape YouTube transcripts.</p>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 8 }}>
          <select value={format} onChange={(e) => setFormat(e.target.value)}>
            <option value="plain_text">plain text</option>
            <option value="srt">SRT</option>
            <option value="vtt">VTT</option>
          </select>
          <button onClick={upload} disabled={!transcript.trim() || busy === 'upload'}>
            {busy === 'upload' ? 'Uploading…' : 'Upload transcript'}
          </button>
          <button onClick={analyze} disabled={busy === 'analyze'}>
            {busy === 'analyze' ? 'Analyzing…' : 'Detect mentions'}
          </button>
          <button onClick={signalize} disabled={busy === 'signals'}>
            Generate signals
          </button>
        </div>
        <textarea
          value={transcript}
          onChange={(e) => setTranscript(e.target.value)}
          placeholder="Paste transcript text or SRT/VTT here"
          style={{ width: '100%', minHeight: 140, background: '#1f2229', color: '#e4e4e7', border: '1px solid #3f3f46', borderRadius: 6, padding: 10 }}
        />
      </section>

      <section style={card}>
        <h3>Detected Mentions</h3>
        {video.mentions.length === 0 ? <p style={muted}>No mentions detected yet.</p> : (
          <table>
            <thead><tr><th>Asset</th><th>Text</th><th>Direction</th><th>Quality</th><th>Pump risk</th><th>Summary</th><th></th></tr></thead>
            <tbody>
              {video.mentions.map((m) => (
                <tr key={m.id}>
                  <td>{m.symbol}</td>
                  <td>{m.mention_text}</td>
                  <td><DirectionBadge direction={m.direction} /></td>
                  <td>{m.mention_quality_score == null ? '—' : m.mention_quality_score.toFixed(0)}</td>
                  <td><PumpRiskBadge score={m.pump_risk_score} /></td>
                  <td style={muted}>{m.summary || m.surrounding_text}</td>
                  <td><button onClick={() => classify(m.id)} disabled={busy === `classify-${m.id}`}>Classify</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section style={card}>
        <h3>Transcript Segments</h3>
        {video.segments.length === 0 ? <p style={muted}>No transcript segments yet.</p> : (
          <div style={{ display: 'grid', gap: 8 }}>
            {video.segments.slice(0, 80).map((s) => (
              <div key={s.id} style={{ border: '1px solid #26282f', borderRadius: 8, padding: 10 }}>
                <div style={{ ...muted, fontSize: '0.8em' }}>{s.start_seconds ?? '—'}s to {s.end_seconds ?? '—'}s</div>
                <div>{s.text}</div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
