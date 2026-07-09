import InfluenceLayout from './influence/InfluenceLayout.jsx'
import YoutubeDashboard from './influence/YoutubeDashboard.jsx'
import YoutubeChannels from './influence/YoutubeChannels.jsx'
import YoutubeChannelProfile from './influence/YoutubeChannelProfile.jsx'
import YoutubeVideos from './influence/YoutubeVideos.jsx'
import YoutubeVideoDetail from './influence/YoutubeVideoDetail.jsx'
import YoutubeMentions from './influence/YoutubeMentions.jsx'
import YoutubeBacktests from './influence/YoutubeBacktests.jsx'
import YoutubeSignals from './influence/YoutubeSignals.jsx'
import { EmptyState, MetricCard, PageHeader, SectionPanel } from '../components/intel/components.jsx'
import { navigate } from './influence/ui.js'

export default function Influence({ path }) {
  const route = path || '/app/influence'
  if (route === '/app/influence') return <InfluenceLanding />

  let content = <YoutubeDashboard />

  const channelMatch = route.match(/^\/app\/influence\/youtube\/channels\/(\d+)$/)
  const videoMatch = route.match(/^\/app\/influence\/youtube\/videos\/(\d+)$/)

  if (channelMatch) content = <YoutubeChannelProfile channelId={Number(channelMatch[1])} />
  else if (videoMatch) content = <YoutubeVideoDetail videoId={Number(videoMatch[1])} />
  else if (route.endsWith('/channels')) content = <YoutubeChannels />
  else if (route.endsWith('/videos')) content = <YoutubeVideos />
  else if (route.endsWith('/mentions')) content = <YoutubeMentions />
  else if (route.endsWith('/backtests')) content = <YoutubeBacktests />
  else if (route.endsWith('/signals')) content = <YoutubeSignals />

  return <InfluenceLayout path={route}>{content}</InfluenceLayout>
}

function InfluenceLanding() {
  const modules = [
    {
      name: 'Politicians',
      description: 'Congress disclosures, filing lag, committee context, and post-disclosure alpha.',
      status: 'Enabled',
      path: '/app/influence/politicians',
      metrics: ['Disclosure lag', 'Copy score', 'Dossiers'],
    },
    {
      name: 'YouTube',
      description: 'Creator mentions, transcript evidence, pump-risk checks, and post-mention backtests.',
      status: 'Enabled',
      path: '/app/influence/youtube',
      metrics: ['Mentions', 'Creator alpha', 'Pump risk'],
    },
    { name: 'X / Twitter', description: 'Public narrative and sentiment module.', status: 'Coming soon' },
    { name: 'Reddit', description: 'Community attention, ticker velocity, and crowding warnings.', status: 'Coming soon' },
    { name: 'Podcasts', description: 'Long-form mention extraction and source trails.', status: 'Coming soon' },
    { name: 'Newsletters', description: 'Editorial recommendations and follow-through evidence.', status: 'Coming soon' },
    { name: 'SEC Filings', description: 'Issuer filings and event-driven evidence trails.', status: 'Coming soon' },
  ]

  return (
    <>
      <PageHeader
        eyebrow="Influence"
        title="Public Influence Modules"
        description="Gateway for political, creator, social, and filing intelligence. Every module must show evidence before actionability."
        meta="Enabled: politicians and YouTube · Future modules staged as disabled"
      />
      <div className="intel-grid" style={{ marginBottom: 16 }}>
        <MetricCard label="Enabled modules" value="2" helper="Politicians + YouTube" tone="info" />
        <MetricCard label="Future sources" value="5" helper="Social, podcasts, newsletters, filings" />
        <MetricCard label="Method" value="Evidence-first" helper="Signal detected is not edge confirmed" tone="warning" />
      </div>
      <div className="intel-grid">
        {modules.map((module) => (
          <SectionPanel
            key={module.name}
            title={module.name}
            description={module.description}
            actions={module.path ? <button onClick={() => navigate(module.path)}>Open</button> : <button disabled>Coming soon</button>}
          >
            <div className="intel-meta-row">{module.status}</div>
            {module.metrics ? (
              <div className="intel-signal-badges" style={{ marginTop: 12 }}>
                {module.metrics.map((metric) => <span key={metric} className="intel-badge source-badge">{metric}</span>)}
              </div>
            ) : (
              <EmptyState title="Module disabled" body="Coverage will be added after source reliability and evidence trails are defined." />
            )}
          </SectionPanel>
        ))}
      </div>
    </>
  )
}
