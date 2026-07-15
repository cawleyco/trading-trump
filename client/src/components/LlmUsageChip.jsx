import { useEffect, useRef, useState } from 'react'
import { api } from '../api.js'

const TAG_LABELS = {
  'sentiment-classifier': 'Sentiment',
  'youtube-classifier': 'YouTube',
  'thesis-polish': 'Thesis',
}

function subjectLine(entry) {
  if (!entry?.subject) return ''
  const s = entry.subject
  if (entry.tag === 'youtube-classifier') {
    return [s.asset, s.video, s.channel].filter(Boolean).join(' · ')
  }
  if (entry.tag === 'sentiment-classifier') return s.preview || ''
  if (entry.tag === 'thesis-polish') {
    return [s.ticker, s.politician, s.tradeKey].filter(Boolean).join(' · ')
  }
  return Object.values(s).filter(Boolean).join(' · ')
}

function relativeTime(ts) {
  if (!ts) return ''
  const ms = Date.now() - new Date(ts).getTime()
  if (!Number.isFinite(ms) || ms < 0) return ''
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.floor(hr / 24)}d ago`
}

export default function LlmUsageChip() {
  const [data, setData] = useState({ callCount: 0, recent: [], totals: {} })
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)

  useEffect(() => {
    const refresh = () => {
      api.llmUsage()
        .then(setData)
        .catch(() => {})
    }
    refresh()
    const t = setInterval(refresh, 5000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    if (!open) return undefined
    const onDoc = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const recent = (data.recent || []).slice(0, 20)
  const last = recent[0]
  const lastSnippet = last ? subjectLine(last) : ''
  const count = data.callCount ?? 0

  return (
    <div className="llm-usage-chip" ref={rootRef}>
      <button
        type="button"
        className={`llm-usage-chip-btn${open ? ' is-open' : ''}${count > 0 ? ' has-calls' : ''}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={lastSnippet ? `Last: ${lastSnippet}` : 'Claude API usage this session'}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="llm-usage-chip-label">Claude · {count}</span>
        {lastSnippet && (
          <span className="llm-usage-chip-last">{lastSnippet}</span>
        )}
      </button>
      {open && (
        <div className="llm-usage-panel" role="dialog" aria-label="Recent Claude API calls">
          <div className="llm-usage-panel-head">
            <strong>Claude usage</strong>
            <span>{count} call{count === 1 ? '' : 's'} this session</span>
          </div>
          {recent.length === 0 ? (
            <div className="llm-usage-empty">No Anthropic calls yet.</div>
          ) : (
            <ul className="llm-usage-list">
              {recent.map((entry, i) => (
                <li key={`${entry.ts}-${entry.tag}-${i}`}>
                  <div className="llm-usage-row-top">
                    <span className="llm-usage-tag">{TAG_LABELS[entry.tag] || entry.tag}</span>
                    <span className="llm-usage-time">{relativeTime(entry.ts)}</span>
                  </div>
                  <div className="llm-usage-subject">{subjectLine(entry) || '—'}</div>
                  <div className="llm-usage-tokens">
                    {entry.input_tokens ?? 0} in · {entry.output_tokens ?? 0} out
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
