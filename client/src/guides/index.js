import overviewMd from './overview.md?raw'
import intelMd from './intel.md?raw'
import signalsMd from './signals.md?raw'
import politiciansMd from './politicians.md?raw'
import youtubeMd from './youtube.md?raw'
import backtestsMd from './backtests.md?raw'
import strategiesMd from './strategies.md?raw'
import alertsMd from './alerts.md?raw'
import calendarMd from './calendar.md?raw'
import tradesMd from './trades.md?raw'
import approvalsMd from './approvals.md?raw'

export const GUIDES = [
  {
    slug: 'overview',
    title: 'Overview Dashboard',
    group: 'Intelligence',
    description: 'Status bar, fund kill switches, positions, pipeline tests, and P&L by source.',
    markdown: overviewMd,
  },
  {
    slug: 'intel',
    title: 'Intel Dashboards',
    group: 'Intelligence',
    description: 'Activity, sector and committee heatmaps, conflict-risk exposure, and copy performance.',
    markdown: intelMd,
  },
  {
    slug: 'signals',
    title: 'Signal Log',
    group: 'Intelligence',
    description: 'The full audit trail — why every signal was accepted or rejected, per fund.',
    markdown: signalsMd,
  },
  {
    slug: 'politicians',
    title: 'Politician Dossiers',
    group: 'Intelligence',
    description: 'Per-member tear sheets: forward returns, edge scores, filing speed, concentration.',
    markdown: politiciansMd,
  },
  {
    slug: 'youtube',
    title: 'YouTube Influence',
    group: 'Intelligence',
    description: 'Creator mentions, transcript evidence, pump-risk, and post-mention backtests.',
    markdown: youtubeMd,
  },
  {
    slug: 'backtests',
    title: 'Backtest Lab',
    group: 'Analysis',
    description: 'Copy-a-politician, leaderboard, and sentiment backtests against a SPY benchmark.',
    markdown: backtestsMd,
  },
  {
    slug: 'strategies',
    title: 'Strategies',
    group: 'Analysis',
    description: 'Saved rule sets over live trades, from watch-only to gated auto-trading.',
    markdown: strategiesMd,
  },
  {
    slug: 'alerts',
    title: 'Alerts',
    group: 'System',
    description: 'Rule types, channels, dedup, and troubleshooting delivery.',
    markdown: alertsMd,
  },
  {
    slug: 'calendar',
    title: 'Political Calendar',
    group: 'Trading ops',
    description: 'Hearings, bill actions, and elections linked to recently traded tickers.',
    markdown: calendarMd,
  },
  {
    slug: 'trades',
    title: 'Congress Trade Feed',
    group: 'Trading ops',
    description: 'Scored disclosures, thesis cards, factor breakdowns, and connections.',
    markdown: tradesMd,
  },
  {
    slug: 'approvals',
    title: 'Approvals',
    group: 'Trading ops',
    description: 'The manual-review queue for strategy-proposed orders.',
    markdown: approvalsMd,
  },
]

export const GUIDE_GROUPS = [...new Set(GUIDES.map((g) => g.group))]

export const guideBySlug = Object.fromEntries(GUIDES.map((g) => [g.slug, g]))
