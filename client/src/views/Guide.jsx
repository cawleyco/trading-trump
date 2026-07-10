import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { EmptyState, PageHeader, SectionPanel } from '../components/intel/components.jsx'
import { GUIDES, GUIDE_GROUPS, guideBySlug } from '../guides/index.js'
import { navigate } from '../lib/navigate.js'

export default function Guide({ path }) {
  const match = (path || '').match(/^\/app\/guide\/([a-z0-9-]+)\/?$/)
  const slug = match ? match[1] : null

  if (!slug) return <GuideIndex />

  const guide = guideBySlug[slug]
  if (!guide) {
    return (
      <>
        <PageHeader eyebrow="System" title="Guide" description="No guide exists at this address." />
        <SectionPanel>
          <EmptyState title="Unknown guide topic" body={`There is no guide named "${slug}".`} />
          <button type="button" onClick={() => navigate('/app/guide')}>Back to all guides</button>
        </SectionPanel>
      </>
    )
  }

  return <GuideArticle guide={guide} />
}

function GuideIndex() {
  return (
    <>
      <PageHeader
        eyebrow="System"
        title="Guide"
        description="How to use every part of the terminal — what each page is for, step-by-step recipes, and the caveats that keep you honest."
        meta="Research tool · not investment advice"
      />
      {GUIDE_GROUPS.map((group) => (
        <SectionPanel key={group} title={group}>
          <div className="guide-card-grid">
            {GUIDES.filter((g) => g.group === group).map((g) => (
              <button
                type="button"
                key={g.slug}
                className="guide-card"
                onClick={() => navigate(`/app/guide/${g.slug}`)}
              >
                <strong>{g.title}</strong>
                <span>{g.description}</span>
              </button>
            ))}
          </div>
        </SectionPanel>
      ))}
    </>
  )
}

function GuideArticle({ guide }) {
  return (
    <>
      <PageHeader eyebrow={`Guide / ${guide.group}`} title={guide.title} description={guide.description} />
      <div className="guide-layout">
        <nav className="guide-toc" aria-label="Guide topics">
          <button type="button" className="guide-toc-home" onClick={() => navigate('/app/guide')}>
            All guides
          </button>
          {GUIDE_GROUPS.map((group) => (
            <div key={group} className="guide-toc-group">
              <div className="guide-toc-label">{group}</div>
              {GUIDES.filter((g) => g.group === group).map((g) => (
                <button
                  type="button"
                  key={g.slug}
                  className={g.slug === guide.slug ? 'is-active' : ''}
                  onClick={() => navigate(`/app/guide/${g.slug}`)}
                >
                  {g.title}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <section className="intel-panel guide-article">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: MarkdownLink }}>
            {guide.markdown}
          </ReactMarkdown>
        </section>
      </div>
    </>
  )
}

function MarkdownLink({ href, children }) {
  if (href && href.startsWith('/app/')) {
    return (
      <a
        href={href}
        onClick={(e) => {
          e.preventDefault()
          navigate(href)
        }}
      >
        {children}
      </a>
    )
  }
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  )
}
