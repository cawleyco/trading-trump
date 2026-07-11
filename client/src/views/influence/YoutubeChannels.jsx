import { useEffect, useMemo, useState } from 'react'
import { api } from '../../api.js'
import { muted, navigate } from './ui.js'
import { DefinitionLabel, SectionPanel } from '../../components/intel/components.jsx'

export default function YoutubeChannels() {
  const [channels, setChannels] = useState([])
  const [sortKey, setSortKey] = useState('subscriber_count')
  const [asc, setAsc] = useState(false)
  const [form, setForm] = useState({ youtube_channel_id: '', title: '', category: 'crypto', influence_tier: 'watchlist' })
  const [resolveWithApi, setResolveWithApi] = useState(false)
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)

  const refresh = () => api.youtubeChannels().then(setChannels).catch((e) => setError(e.message))
  useEffect(() => { refresh() }, [])

  const sortedChannels = useMemo(() => {
    return [...channels].sort((a, b) => compareChannels(a, b, sortKey, asc))
  }, [channels, sortKey, asc])

  const sortBy = (key, defaultAsc = false) => {
    if (sortKey === key) setAsc(!asc)
    else {
      setSortKey(key)
      setAsc(defaultAsc)
    }
  }

  const sortableTh = (key, label, defaultAsc = false) => (
    <th onClick={() => sortBy(key, defaultAsc)} style={{ cursor: 'pointer', userSelect: 'none' }}>
      <DefinitionLabel>{label}</DefinitionLabel>{sortKey === key ? (asc ? ' ▲' : ' ▼') : ''}
    </th>
  )

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
                {sortableTh('title', 'Channel', true)}<th><DefinitionLabel>Category</DefinitionLabel></th>{sortableTh('subscriber_count', 'Subscribers')}<th><DefinitionLabel>Tracked?</DefinitionLabel></th>
                {sortableTh('videos_analyzed', 'Videos')}<th><DefinitionLabel>Mentions</DefinitionLabel></th><th><DefinitionLabel>Trust</DefinitionLabel></th><th><DefinitionLabel>Alpha</DefinitionLabel></th><th><DefinitionLabel>Win 30d</DefinitionLabel></th><th><DefinitionLabel>Pump risk</DefinitionLabel></th>{sortableTh('last_synced_at', 'Last synced')}<th><DefinitionLabel>Actions</DefinitionLabel></th>
              </tr>
            </thead>
            <tbody>
              {sortedChannels.map((c) => (
                <tr key={c.id}>
                  <td>{c.title}</td>
                  <td>{c.category || '—'}</td>
                  <td><SubscriberCount value={c.subscriber_count} /></td>
                  <td>{c.tracking_enabled ? 'yes' : 'no'}</td>
                  <td>{c.videos_analyzed ?? 0}</td>
                  <td>{c.mentions_detected ?? 0}</td>
                  <td><TrustBadge label={c.alpha_label} measurable={c.measurable_mentions} /></td>
                  <td style={{ fontFamily: 'var(--font-mono)' }}>{trusted(c) ? formatPct(c.alpha_score) : '—'}</td>
                  <td>{trusted(c) ? formatRate(c.win_rate_30d) : '—'}</td>
                  <td>{formatPct(c.pump_risk_score == null ? null : Number(c.pump_risk_score) * 100)}</td>
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

function compareChannels(a, b, sortKey, asc) {
  const av = sortableValue(a, sortKey)
  const bv = sortableValue(b, sortKey)
  const direction = asc ? 1 : -1
  if (av == null && bv == null) return String(a.title || '').localeCompare(String(b.title || ''))
  if (av == null) return 1
  if (bv == null) return -1
  if (typeof av === 'string' || typeof bv === 'string') {
    return String(av).localeCompare(String(bv)) * direction || String(a.title || '').localeCompare(String(b.title || ''))
  }
  return (av - bv) * direction || String(a.title || '').localeCompare(String(b.title || ''))
}

function sortableValue(channel, key) {
  if (key === 'title') return channel.title || ''
  if (key === 'last_synced_at') return channel.last_synced_at ? Date.parse(channel.last_synced_at) : null
  const value = channel[key]
  return value == null ? null : Number(value)
}

function SubscriberCount({ value }) {
  if (value == null) {
    return <span style={muted}>Unavailable</span>
  }
  const count = Number(value)
  return (
    <span style={{ display: 'grid', gap: 2 }}>
      <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{formatSubscriberCount(count)}</strong>
      <span style={{ ...muted, fontSize: '0.82em', whiteSpace: 'nowrap' }}>{count.toLocaleString()} subscribers</span>
    </span>
  )
}

function Field({ label, children }) {
  return <label style={{ display: 'grid', gap: 4, color: 'var(--color-text-muted)', fontSize: '0.85em' }}>{label}{children}</label>
}

function formatSubscriberCount(value) {
  return new Intl.NumberFormat(undefined, {
    notation: 'compact',
    maximumFractionDigits: value >= 1_000_000 ? 1 : 0,
  }).format(value)
}

function formatRate(v) {
  return v == null ? '—' : `${(Number(v) * 100).toFixed(0)}%`
}

// A creator's alpha/win-rate is only shown once it clears the minimum-sample
// bar — a naked win-rate over 4 mentions reads as edge when it's noise.
// Allowlist the trusted labels so legacy rows (old label scheme) stay hidden
// until the nightly refresh rewrites them.
const TRUSTED_LABELS = ['follow', 'fade', 'neutral']

function trusted(channel) {
  return TRUSTED_LABELS.includes(channel.alpha_label)
}

function TrustBadge({ label, measurable }) {
  if (!TRUSTED_LABELS.includes(label)) {
    return <span style={{ ...muted, whiteSpace: 'nowrap' }} title="Needs 10 measurable 30d mentions before alpha is scored">n/a ({measurable ?? 0}/10)</span>
  }
  const tone = label === 'follow' ? 'var(--color-bullish)' : label === 'fade' ? 'var(--color-bearish)' : 'var(--color-text-muted)'
  return (
    <span style={{ color: tone, fontWeight: 600, textTransform: 'uppercase', whiteSpace: 'nowrap' }} title={`${measurable} measurable mentions`}>
      {label}
    </span>
  )
}

function formatPct(v) {
  return v == null ? '—' : Number(v).toFixed(0)
}
