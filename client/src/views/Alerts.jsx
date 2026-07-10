import { useCallback, useEffect, useState } from 'react'
import { api } from '../api.js'
import {
  PageHeader,
  SectionPanel,
  IntelligenceTable,
  EmptyState,
} from '../components/intel/components.jsx'
import { InvestButton } from '../components/InvestButton.jsx'

const RULE_HELP = {
  'high-score-trade': 'Fires when a scored trade\'s copy score ≥ minScore. Params: {"minScore": 85}',
  'watchlist-activity': 'Fires when a trade or event touches a watched ticker/politician/sector/committee. No params.',
  cluster: 'Fires when ≥ clusterCount members trade the same ticker/direction. Params: {"clusterCount": 3, "windowDays": 30}',
  'committee-relevant': 'Fires when the committee-relevance factor ≥ minRelevance. Params: {"minRelevance": 50}',
  'stale-warning': 'Fires when a scored trade carries a stale-disclosure warning. No params.',
  'strategy-match': 'Fires when any strategy matches a trade. No params.',
  'tweet-catalyst': 'Fires when a classified post is market-relevant. No params.',
}

const DEFAULT_PARAMS = {
  'high-score-trade': '{"minScore": 85}',
  cluster: '{"clusterCount": 3, "windowDays": 30}',
  'committee-relevant': '{"minRelevance": 50}',
}

export default function Alerts() {
  const [meta, setMeta] = useState({ rules: [], ruleTypes: [], channels: ['all'] })
  const [feed, setFeed] = useState([])
  const [error, setError] = useState(null)

  const load = useCallback(() => {
    Promise.all([api.alertRules(), api.alertFeed(100)])
      .then(([m, f]) => { setMeta(m); setFeed(f); setError(null) })
      .catch((e) => setError(e.message))
  }, [])

  useEffect(() => { load() }, [load])

  return (
    <>
      <PageHeader
        eyebrow="System"
        helpSlug="alerts"
        title="Alerts"
        description="Rules evaluate at natural moments — a trade is scored, a strategy matches, a post is classified, the calendar refreshes — and route explanatory, deduplicated alerts through macOS and Discord."
        meta="Every alert states the why · dedup prevents repeats"
      />
      {error && <p style={{ color: 'var(--color-bearish)' }}>{error}</p>}

      <RuleEditor meta={meta} onChange={load} setError={setError} />

      <SectionPanel title="Alert rules" description="Enabled rules fire automatically; disabled rules are kept but skipped.">
        {meta.rules.length === 0 ? (
          <EmptyState title="No alert rules yet" body="Add a rule above to start receiving explanatory alerts." />
        ) : (
          <IntelligenceTable
            rowKey={(r) => r.id}
            columns={[
              { key: 'rule_type', label: 'Type', mono: true },
              { key: 'params', label: 'Params', render: (r) => <code>{JSON.stringify(r.params)}</code> },
              { key: 'channel', label: 'Channel' },
              {
                key: 'enabled',
                label: 'Enabled',
                render: (r) => (
                  <button type="button" onClick={() => toggle(r, load, setError)}>
                    {r.enabled ? 'On' : 'Off'}
                  </button>
                ),
              },
              {
                key: 'remove',
                label: '',
                render: (r) => (
                  <button type="button" onClick={() => remove(r.id, load, setError)}>Delete</button>
                ),
              },
            ]}
            rows={meta.rules}
          />
        )}
      </SectionPanel>

      <SectionPanel title="Alert feed" description="Recently fired alerts (deduplicated by subject).">
        {feed.length === 0 ? (
          <p className="intel-muted">No alerts fired yet.</p>
        ) : (
          <IntelligenceTable
            rowKey={(r) => r.id}
            columns={[
              { key: 'sent_at', label: 'When', render: (r) => r.sent_at },
              { key: 'rule_type', label: 'Rule', mono: true, render: (r) => r.rule_type || '(deleted)' },
              { key: 'message', label: 'Message' },
              {
                key: 'invest',
                label: '',
                render: (r) => {
                  const ticker = tickerFromAlert(r)
                  if (!ticker) return null
                  return (
                    <InvestButton
                      ticker={ticker}
                      origin={{ kind: 'alert', alertId: r.id, surface: 'alerts' }}
                    />
                  )
                },
              },
            ]}
            rows={feed}
          />
        )}
      </SectionPanel>
    </>
  )
}

function tickerFromAlert(row) {
  const fromKey = String(row.dedup_key || '').split(':').find((part) => /^[A-Z][A-Z.]{0,9}$/.test(part))
  if (fromKey) return fromKey
  const match = String(row.message || '').match(/\b([A-Z]{1,5}(?:\.[A-Z])?)\b/)
  return match?.[1] || null
}

async function toggle(rule, reload, setError) {
  try {
    await api.updateAlertRule(rule.id, { enabled: !rule.enabled })
    reload()
  } catch (e) {
    setError(e.message)
  }
}

async function remove(id, reload, setError) {
  try {
    await api.deleteAlertRule(id)
    reload()
  } catch (e) {
    setError(e.message)
  }
}

function RuleEditor({ meta, onChange, setError }) {
  const [ruleType, setRuleType] = useState('')
  const [params, setParams] = useState('')
  const [channel, setChannel] = useState('all')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!ruleType && meta.ruleTypes.length) setRuleType(meta.ruleTypes[0])
  }, [meta.ruleTypes, ruleType])

  const onSelectType = (t) => {
    setRuleType(t)
    setParams(DEFAULT_PARAMS[t] || '')
  }

  const add = async () => {
    setError(null)
    let parsed = {}
    if (params.trim()) {
      try {
        parsed = JSON.parse(params)
      } catch {
        setError('Params must be valid JSON (or empty).')
        return
      }
    }
    setSaving(true)
    try {
      await api.createAlertRule({ ruleType, params: parsed, channel })
      setParams(DEFAULT_PARAMS[ruleType] || '')
      onChange()
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <SectionPanel title="New rule" description={RULE_HELP[ruleType] || 'Choose a rule type.'}>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'end' }}>
        <label style={label}>
          Rule type
          <select value={ruleType} onChange={(e) => onSelectType(e.target.value)}>
            {meta.ruleTypes.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label style={{ ...label, flex: 1, minWidth: 220 }}>
          Params (JSON)
          <input value={params} onChange={(e) => setParams(e.target.value)} placeholder="{}" />
        </label>
        <label style={label}>
          Channel
          <select value={channel} onChange={(e) => setChannel(e.target.value)}>
            {meta.channels.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <button onClick={add} disabled={saving || !ruleType}>{saving ? 'Adding…' : 'Add rule'}</button>
      </div>
    </SectionPanel>
  )
}

const label = { display: 'grid', gap: 4, color: 'var(--color-text-muted)', fontSize: '0.78em' }
