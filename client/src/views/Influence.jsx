import InfluenceLayout from './influence/InfluenceLayout.jsx'
import YoutubeDashboard from './influence/YoutubeDashboard.jsx'
import YoutubeChannels from './influence/YoutubeChannels.jsx'
import YoutubeChannelProfile from './influence/YoutubeChannelProfile.jsx'
import YoutubeVideos from './influence/YoutubeVideos.jsx'
import YoutubeVideoDetail from './influence/YoutubeVideoDetail.jsx'
import YoutubeMentions from './influence/YoutubeMentions.jsx'
import YoutubeBacktests from './influence/YoutubeBacktests.jsx'
import YoutubeSignals from './influence/YoutubeSignals.jsx'

export default function Influence({ path }) {
  const route = path || '/app/influence/youtube'
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
