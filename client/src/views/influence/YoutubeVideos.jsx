import { useEffect, useState } from 'react'
import { api } from '../../api.js'
import { card, muted, navigate } from './ui.js'

export default function YoutubeVideos() {
  const [channels, setChannels] = useState([])
  const [videos, setVideos] = useState([])
  const [form, setForm] = useState({ channel_id: '', youtube_video_id: '', title: '', published_at: new Date().toISOString() })
  const [error, setError] = useState(null)

  const refresh = () => {
    api.youtubeChannels().then((rows) => {
      setChannels(rows)
      setForm((f) => ({ ...f, channel_id: f.channel_id || rows[0]?.id || '' }))
    }).catch(() => {})
    api.youtubeVideos().then(setVideos).catch((e) => setError(e.message))
  }
  useEffect(() => { refresh() }, [])

  const submit = async (e) => {
    e.preventDefault()
    setError(null)
    try {
      await api.createYoutubeVideo({ ...form, channel_id: Number(form.channel_id) })
      setForm({ ...form, youtube_video_id: '', title: '', published_at: new Date().toISOString() })
      refresh()
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <div>
      <section style={card}>
        <h3>Manual Video Seed</h3>
        <p style={muted}>Use this for fixture/demo videos when metadata sync is not configured.</p>
        <form onSubmit={submit} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Field label="Channel">
            <select value={form.channel_id} onChange={(e) => setForm({ ...form, channel_id: e.target.value })}>
              {channels.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
            </select>
          </Field>
          <Field label="YouTube video ID">
            <input value={form.youtube_video_id} onChange={(e) => setForm({ ...form, youtube_video_id: e.target.value })} />
          </Field>
          <Field label="Title">
            <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} style={{ width: 260 }} />
          </Field>
          <Field label="Published ISO">
            <input value={form.published_at} onChange={(e) => setForm({ ...form, published_at: e.target.value })} style={{ width: 220 }} />
          </Field>
          <button>Add video</button>
        </form>
        {error && <p style={{ color: '#fca5a5' }}>{error}</p>}
      </section>

      <section style={card}>
        <h3>Videos</h3>
        {videos.length === 0 ? <p style={muted}>No videos stored yet.</p> : (
          <table>
            <thead><tr><th>Published</th><th>Channel</th><th>Title</th><th>Transcript</th><th>Analysis</th><th></th></tr></thead>
            <tbody>
              {videos.map((v) => (
                <tr key={v.id}>
                  <td>{v.published_at}</td>
                  <td>{v.channel_title}</td>
                  <td>{v.title}</td>
                  <td>{v.transcript_status}</td>
                  <td>{v.analysis_status}</td>
                  <td><button onClick={() => navigate(`/app/influence/youtube/videos/${v.id}`)}>Open</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}

function Field({ label, children }) {
  return <label style={{ display: 'grid', gap: 4, color: '#a1a1aa', fontSize: '0.85em' }}>{label}{children}</label>
}
