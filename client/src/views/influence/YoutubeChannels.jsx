import { useEffect, useState } from 'react'
import { api } from '../../api.js'
import { muted, navigate } from './ui.js'
import { DefinitionLabel, SectionPanel } from '../../components/intel/components.jsx'

export default function YoutubeChannels() {
  const [channels, setChannels] = useState([])
  const [form, setForm] = useState({ youtube_channel_id: '', title: '', category: 'crypto', influence_tier: 'watchlist' })
  const [resolveWithApi, setResolveWithApi] = useState(false)
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)

  const refresh = () => api.youtubeChannels().then(setChannels).catch((e) => setError(e.message))
  useEffect(() => { refresh() }, [])

  const submit = async (e) => {
    e.preventDefault()
    setBusy('save')
    setError(null)
    try {
      await api.createYoutubeChannel(resolveWithApi ? { input: form.youtube_channel_id || form.handle, ...form, resolveWithApi: true } : form)
      setForm({ youtube_channel_id: '', title: '', category: 'crypto', influence_tier: 'watchlist' })
      await refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(null)
    }
  }

  const sync = async (id) => {
    setBusy(`sync-${id}`)
    setError(null)
    try {
      await api.syncYoutubeChannel(id)
      await refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div>
      <SectionPanel title="Add YouTube Channel" description="Manual channel data works without a YouTube key. Enable API resolve/sync when `YOUTUBE_API_KEY` is configured.">
        <form onSubmit={submit} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Field label={resolveWithApi ? 'Channel URL, handle, or ID' : 'YouTube channel ID'}>
            <input value={form.youtube_channel_id} onChange={(e) => setForm({ ...form, youtube_channel_id: e.target.value })} style={{ width: 220 }} />
          </Field>
          {!resolveWithApi && (
            <Field label="Title">
              <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} style={{ width: 220 }} />
            </Field>
          )}
          <Field label="Category">
            <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
              <option value="crypto">crypto</option>
              <option value="finance">finance</option>
              <option value="macro">macro</option>
              <option value="trading">trading</option>
              <option value="mixed">mixed</option>
            </select>
          </Field>
          <Field label="Tier">
            <select value={form.influence_tier} onChange={(e) => setForm({ ...form, influence_tier: e.target.value })}>
              <option value="mega">mega</option>
              <option value="large">large</option>
              <option value="medium">medium</option>
              <option value="small">small</option>
              <option value="watchlist">watchlist</option>
            </select>
          </Field>
          <label style={{ ...muted, display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={resolveWithApi} onChange={(e) => setResolveWithApi(e.target.checked)} />
            Resolve with API
          </label>
          <button disabled={busy === 'save'}>{busy === 'save' ? 'Saving…' : 'Add channel'}</button>
        </form>
        {error && <p style={{ color: 'var(--color-bearish)' }}>{error}</p>}
      </SectionPanel>

      <SectionPanel title="Creator Dossier Index" description="Creator alpha, sample size, and pump-risk determine whether a channel is useful or merely noisy.">
        {channels.length === 0 ? <p style={muted}>No channels tracked yet.</p> : (
          <table>
            <thead>
              <tr>
                <th><DefinitionLabel>Channel</DefinitionLabel></th><th><DefinitionLabel>Category</DefinitionLabel></th><th><DefinitionLabel>Subscribers</DefinitionLabel></th><th><DefinitionLabel>Tracked?</DefinitionLabel></th>
                <th><DefinitionLabel>Videos</DefinitionLabel></th><th><DefinitionLabel>Mentions</DefinitionLabel></th><th><DefinitionLabel>Alpha</DefinitionLabel></th><th><DefinitionLabel>Win 30d</DefinitionLabel></th><th><DefinitionLabel>Pump risk</DefinitionLabel></th><th><DefinitionLabel>Last synced</DefinitionLabel></th><th><DefinitionLabel>Actions</DefinitionLabel></th>
              </tr>
            </thead>
            <tbody>
              {channels.map((c) => (
                <tr key={c.id}>
                  <td>{c.title}</td>
                  <td>{c.category || '—'}</td>
                  <td>{c.subscriber_count ?? '—'}</td>
                  <td>{c.tracking_enabled ? 'yes' : 'no'}</td>
                  <td>{c.videos_analyzed ?? 0}</td>
                  <td>{c.mentions_detected ?? 0}</td>
                  <td style={{ fontFamily: 'var(--font-mono)' }}>{formatPct(c.alpha_score)}</td>
                  <td>{formatRate(c.win_rate_30d)}</td>
                  <td>{formatPct(c.pump_risk_score)}</td>
                  <td>{c.last_synced_at || '—'}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button onClick={() => navigate(`/app/influence/youtube/channels/${c.id}`)} style={{ marginRight: 6 }}>View</button>
                    <button onClick={() => sync(c.id)} disabled={busy === `sync-${c.id}`}>
                      {busy === `sync-${c.id}` ? 'Syncing…' : 'Sync now'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SectionPanel>
    </div>
  )
}

function Field({ label, children }) {
  return <label style={{ display: 'grid', gap: 4, color: 'var(--color-text-muted)', fontSize: '0.85em' }}>{label}{children}</label>
}

function formatRate(v) {
  return v == null ? '—' : `${(Number(v) * 100).toFixed(0)}%`
}

function formatPct(v) {
  return v == null ? '—' : Number(v).toFixed(0)
}
