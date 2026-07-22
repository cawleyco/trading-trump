import { Fragment, useEffect, useMemo, useState } from 'react'
import { api } from '../../api.js'
import { card, muted } from './ui.js'

const WINDOWS = ['1h', '6h', '24h', '7d', '30d', '90d']

// Abnormal return = asset move minus its window-matched benchmark (SPY for
// equities, BTC for crypto). It isolates the video's effect from broad-market /
// asset-class drift, so a narrative's bar answers "how far did the asset move
// beyond what its market did anyway".
export default function YoutubeNarratives() {
  const [rows, setRows] = useState([])
  const [kind, setKind] = useState('mention_type')
  const [window, setWindow] = useState('7d')
  const [error, setError] = useState(null)
  const [refreshing, setRefreshing] = useState(false)
  const [themeStatus, setThemeStatus] = useState(null)
  const [tagging, setTagging] = useState(false)
  const [expandedKey, setExpandedKey] = useState(null)

  const load = (k = kind) => api.youtubeNarratives(k).then(setRows).catch((e) => setError(e.message))
  useEffect(() => { setError(null); load(kind) }, [kind])
  useEffect(() => { api.youtubeThemeStatus().then(setThemeStatus).catch(() => {}) }, [])

  // Map theme keys → readable labels; mention_type keys just lose underscores.
  const themeLabels = useMemo(() => {
    const m = {}
    for (const t of themeStatus?.taxonomy || []) m[t.key] = t.label
    return m
  }, [themeStatus])
  const labelFor = (narr) => themeLabels[narr] || String(narr).replace(/_/g, ' ')

  const refresh = async () => {
    setRefreshing(true)
    setError(null)
    try {
      const res = await api.refreshYoutubeNarratives({ kind })
      setRows(res.metrics || [])
    } catch (e) {
      setError(e.message)
    } finally {
      setRefreshing(false)
    }
  }

  const tagThemes = async () => {
    setTagging(true)
    setError(null)
    try {
      await api.tagYoutubeThemes({})
      setThemeStatus(await api.youtubeThemeStatus())
    } catch (e) {
      setError(e.message)
    } finally {
      setTagging(false)
    }
  }

  // One measurable window's stats per row, sorted by abnormal return.
  const ranked = useMemo(() => {
    return rows
      .map((r) => ({ ...r, w: r.by_window?.[window] }))
      .filter((r) => r.w && !r.w.insufficient)
      .sort((a, b) => (b.w.avg_abnormal_return ?? -1e9) - (a.w.avg_abnormal_return ?? -1e9))
  }, [rows, window])

  const maxAbs = useMemo(
    () => Math.max(1, ...ranked.map((r) => Math.abs(r.w.avg_abnormal_return ?? 0))),
    [ranked]
  )

  const insufficient = rows.length - ranked.length
  const themesTagged = themeStatus?.totals?.mentions || 0

  return (
    <div>
      <section style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <h3 style={{ margin: 0 }}>Narrative → Price Impact</h3>
            <p style={{ ...muted, maxWidth: 620 }}>
              Abnormal return (asset move − its benchmark: SPY for equities, BTC for crypto) after mentions
              carrying each narrative, anchored to the mention time. Direction-agnostic: a “bearish warning”
              scores by whether the asset actually fell, not by whether the creator was right. Groups below
              the minimum sample are hidden.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <label style={{ display: 'grid', gap: 4, color: 'var(--color-text-muted)', fontSize: '0.85em' }}>
              Narrative axis
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="mention_type">Structured (mention type)</option>
                <option value="theme">Semantic themes</option>
              </select>
            </label>
            <label style={{ display: 'grid', gap: 4, color: 'var(--color-text-muted)', fontSize: '0.85em' }}>
              Window
              <select value={window} onChange={(e) => setWindow(e.target.value)}>
                {WINDOWS.map((w) => <option key={w} value={w}>{w}</option>)}
              </select>
            </label>
            <button onClick={refresh} disabled={refreshing}>{refreshing ? 'Pricing…' : 'Recompute'}</button>
          </div>
        </div>
        {error && <p style={{ color: 'var(--color-bearish)' }}>{error}</p>}
        {kind === 'theme' && (
          <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--color-border-subtle)', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={muted}>
              Themes tag the <em>substance</em> of a mention (AI buildout, rate cuts, bubble warning…), not its structure.
              {' '}{themesTagged > 0 ? `${themesTagged} mentions tagged.` : 'No mentions tagged yet.'}
            </span>
            {themeStatus && !themeStatus.enabled && (
              <span style={{ color: 'var(--color-warning)' }}>
                Tagging is opt-in (spends LLM tokens) — set <code>YOUTUBE_THEME_TAGGING_ENABLED=true</code> to enable.
              </span>
            )}
            <button onClick={tagThemes} disabled={tagging || (themeStatus && !themeStatus.enabled)}>
              {tagging ? 'Tagging…' : themesTagged > 0 ? 'Tag new mentions' : 'Tag themes'}
            </button>
            {themesTagged > 0 && <button onClick={refresh} disabled={refreshing}>Recompute by theme</button>}
          </div>
        )}
        {rows.length === 0 && !error && (
          <p style={muted}>
            {kind === 'theme'
              ? 'No theme metrics yet — tag mentions, then Recompute by theme.'
              : <>No narrative metrics yet — click <strong>Recompute</strong> to price every classified mention.</>}
          </p>
        )}
      </section>

      {ranked.length > 0 && (
        <section style={card}>
          <h3>Abnormal return by narrative · {window}</h3>
          <div style={{ display: 'grid', gap: 6 }}>
            {ranked.map((r) => (
              <NarrativeBar key={`${r.narrative}|${r.direction}|${r.asset_type}`} row={r} maxAbs={maxAbs} label={labelFor(r.narrative)} />
            ))}
          </div>
          {insufficient > 0 && (
            <p style={{ ...muted, marginTop: 10 }}>
              {insufficient} narrative group{insufficient === 1 ? '' : 's'} hidden for this window (below minimum sample).
            </p>
          )}
        </section>
      )}

      {ranked.length > 0 && (
        <section style={card}>
          <h3>Detail</h3>
          <p style={{ ...muted, marginTop: -4 }}>Click a row to see the videos, channels, and stocks behind it.</p>
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th></th>
                  <th>Narrative</th><th>Dir</th><th>Asset</th><th>n</th><th>Abn. return</th>
                  <th>Median</th><th>Raw</th><th>Beat mkt</th><th>|t|</th>
                </tr>
              </thead>
              <tbody>
                {ranked.map((r) => {
                  const w = r.w
                  const rowKey = `${r.narrative}|${r.direction}|${r.asset_type}`
                  const open = expandedKey === rowKey
                  return (
                    <Fragment key={rowKey}>
                      <tr
                        onClick={() => setExpandedKey(open ? null : rowKey)}
                        style={{ cursor: 'pointer', background: open ? 'var(--color-bg-muted, rgba(127,127,127,0.08))' : undefined }}
                      >
                        <td style={{ color: 'var(--color-text-muted)', width: 18 }}>{open ? '▾' : '▸'}</td>
                        <td>{labelFor(r.narrative)}</td>
                        <td style={{ color: dirColor(r.direction) }}>{r.direction}</td>
                        <td style={muted}>{r.asset_type}</td>
                        <td>{w.measurable}</td>
                        <td style={{ color: pnlColor(w.avg_abnormal_return) }}>{pct(w.avg_abnormal_return)}</td>
                        <td>{pct(w.median_abnormal_return)}</td>
                        <td>{pct(w.avg_raw_return)}</td>
                        <td>{w.beat_market_rate == null ? '—' : `${Math.round(w.beat_market_rate * 100)}%`}</td>
                        <td style={{ fontWeight: w.significant ? 700 : 400, color: w.significant ? 'var(--color-text-primary)' : 'var(--color-text-muted)' }}>
                          {w.t_stat == null ? '—' : Math.abs(w.t_stat).toFixed(1)}{w.significant ? ' *' : ''}
                        </td>
                      </tr>
                      {open && (
                        <tr>
                          <td colSpan={10} style={{ padding: 0 }}>
                            <NarrativeDrilldown row={r} kind={kind} window={window} label={labelFor(r.narrative)} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p style={{ ...muted, marginTop: 10 }}>
            <strong>*</strong> = mean abnormal return is statistically distinguishable from zero (|t| ≥ 2) — a
            quick screen, not a full event-study test. Small samples stay unmarked even when the average looks large.
          </p>
        </section>
      )}
    </div>
  )
}

function NarrativeBar({ row, maxAbs, label }) {
  const val = row.w.avg_abnormal_return ?? 0
  const widthPct = (Math.abs(val) / maxAbs) * 50 // half-width; 0 sits at center
  const positive = val >= 0
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr 80px', gap: 10, alignItems: 'center' }}>
      <div style={{ fontSize: '0.85em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {label} <span style={{ color: dirColor(row.direction) }}>· {row.direction}</span>
        <span style={muted}> · {row.asset_type} · n={row.w.measurable}</span>
      </div>
      <div style={{ position: 'relative', height: 18, background: 'var(--color-bg-muted, rgba(127,127,127,0.12))', borderRadius: 4 }}>
        <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: 'var(--color-border-subtle)' }} />
        <div
          style={{
            position: 'absolute', top: 2, bottom: 2,
            left: positive ? '50%' : `${50 - widthPct}%`,
            width: `${widthPct}%`,
            background: pnlColor(val),
            borderRadius: 3,
            opacity: row.w.significant ? 1 : 0.5,
          }}
        />
      </div>
      <div style={{ textAlign: 'right', fontSize: '0.85em', color: pnlColor(val) }}>{pct(val)}</div>
    </div>
  )
}

// Expandable panel showing the constituent videos/channels/stocks behind one
// narrative group, with live filters that recompute the impact over the subset.
function NarrativeDrilldown({ row, kind, window, label }) {
  const [channelId, setChannelId] = useState('')
  const [videoId, setVideoId] = useState('')
  const [minQuality, setMinQuality] = useState('')
  const [since, setSince] = useState('')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    let live = true
    setLoading(true)
    setError(null)
    api
      .narrativeMentions({
        kind,
        narrative: row.narrative,
        direction: row.direction,
        asset_type: row.asset_type,
        channelId,
        videoId,
        minQuality,
        since,
      })
      .then((res) => { if (live) setData(res) })
      .catch((e) => { if (live) setError(e.message) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [kind, row.narrative, row.direction, row.asset_type, channelId, videoId, minQuality, since])

  const options = data?.filterOptions || { channels: [], videos: [] }
  const stat = data?.stats?.by_window?.[window]
  const mentions = data?.mentions || []
  const selectStyle = { maxWidth: 220 }
  const fieldLabel = { display: 'grid', gap: 4, color: 'var(--color-text-muted)', fontSize: '0.8em' }

  return (
    <div style={{ padding: '12px 8px', borderTop: '1px solid var(--color-border-subtle)' }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 10 }}>
        <label style={fieldLabel}>
          Channel
          <select value={channelId} onChange={(e) => setChannelId(e.target.value)} style={selectStyle}>
            <option value="">All channels</option>
            {options.channels.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
          </select>
        </label>
        <label style={fieldLabel}>
          Video
          <select value={videoId} onChange={(e) => setVideoId(e.target.value)} style={selectStyle}>
            <option value="">All videos</option>
            {options.videos.map((v) => <option key={v.id} value={v.id}>{v.title}</option>)}
          </select>
        </label>
        <label style={fieldLabel}>
          Min quality
          <input type="number" min="0" max="100" step="1" value={minQuality} placeholder="0"
            onChange={(e) => setMinQuality(e.target.value)} style={{ width: 90 }} />
        </label>
        <label style={fieldLabel}>
          Since
          <input type="date" value={since} onChange={(e) => setSince(e.target.value)} />
        </label>
        {(channelId || videoId || minQuality || since) && (
          <button onClick={() => { setChannelId(''); setVideoId(''); setMinQuality(''); setSince('') }}>Reset</button>
        )}
      </div>

      <div style={{ ...muted, marginBottom: 8 }}>
        {loading ? 'Pricing subset…' : error ? (
          <span style={{ color: 'var(--color-bearish)' }}>{error}</span>
        ) : stat && !stat.insufficient ? (
          <>Filtered impact · <strong>{label}</strong> · {window}: n={stat.measurable}, avg abnormal{' '}
            <span style={{ color: pnlColor(stat.avg_abnormal_return) }}>{pct(stat.avg_abnormal_return)}</span></>
        ) : (
          <>Filtered impact · {window}: {mentions.length} mention{mentions.length === 1 ? '' : 's'} (below minimum sample for stable stats)</>
        )}
      </div>

      {mentions.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>Stock</th><th>Abn. return · {window}</th><th>Dir</th><th>Video</th><th>Channel</th><th>Date</th>
              </tr>
            </thead>
            <tbody>
              {mentions.map((m) => {
                const abn = m.by_window?.[window]?.abnormal_return
                return (
                  <tr key={m.mention_id}>
                    <td style={{ fontWeight: 600 }}>{m.symbol}</td>
                    <td style={{ color: pnlColor(abn) }}>{pct(abn)}</td>
                    <td style={{ color: dirColor(m.direction) }}>{m.direction}</td>
                    <td style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {videoLink(m)}
                    </td>
                    <td style={muted}>{m.channel_title || '—'}</td>
                    <td style={muted}>{m.event_time ? String(m.event_time).slice(0, 10) : '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {!loading && !error && mentions.length === 0 && (
        <p style={muted}>No mentions match these filters.</p>
      )}
    </div>
  )
}

// Deep-link to the exact moment the stock was mentioned in the video.
function videoLink(m) {
  const title = m.video_title || '(untitled video)'
  if (!m.youtube_video_id) return title
  const t = Math.max(0, Math.floor(m.mention_start_seconds || 0))
  return (
    <a href={`https://www.youtube.com/watch?v=${m.youtube_video_id}&t=${t}s`} target="_blank" rel="noreferrer"
      style={{ color: 'var(--color-accent-primary)' }} onClick={(e) => e.stopPropagation()}>
      {title}
    </a>
  )
}

function pct(v) {
  return v == null ? '—' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(2)}%`
}
function pnlColor(v) {
  if (v == null) return 'var(--color-text-muted)'
  return v >= 0 ? 'var(--color-bullish)' : 'var(--color-bearish)'
}
function dirColor(d) {
  return d === 'bullish' ? 'var(--color-bullish)' : d === 'bearish' ? 'var(--color-bearish)' : 'var(--color-text-secondary)'
}
