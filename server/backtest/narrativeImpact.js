// Narrative impact refresh: price every classified mention, then aggregate the
// ABNORMAL return (asset move minus window-matched SPY) by narrative so we can
// directly compare "how much did the market move after videos carrying this
// narrative". Unlike creator-alpha, this is NOT gated on the creator's
// direction — abnormal return is the raw asset move, so a "bearish warning"
// narrative is measured by whether the asset actually fell, not by whether the
// creator was right.

import { listAssetMentions, replaceNarrativeAlphaMetrics, getMentionThemeMap } from '../db.js';
import { priceMentions, alpacaPriceProvider } from './youtubeBacktest.js';
import { aggregateByNarrative, rawNarrativeMetrics, NARRATIVE_WINDOWS } from '../influence/narrativeStats.js';
import { TAXONOMY_VERSION } from '../influence/narrativeThemes.js';
import { log } from '../logger.js';

// Only mentions with a resolved direction bucket are worth grouping; unknown /
// joke_or_irrelevant classifications add noise, not narrative.
const GROUPABLE_DIRECTIONS = new Set(['bullish', 'bearish', 'neutral', 'mixed']);

/**
 * Recompute a narrative-impact snapshot over the whole corpus and persist it.
 * `kind` selects the narrative axis: 'mention_type' (structured, always
 * available) or 'theme' (semantic, requires themes to have been tagged first).
 * A theme-tagged mention expands into one row per theme, so a mention carrying
 * two themes contributes to both groups. Returns the stored metric rows.
 */
export async function refreshNarrativeImpact({
  provider = alpacaPriceProvider,
  limit = 5000,
  minMentionQualityScore = 0,
  kind = 'mention_type',
} = {}) {
  const mentions = listAssetMentions({ limit }).filter(
    (m) =>
      m.mention_type &&
      GROUPABLE_DIRECTIONS.has(m.direction) &&
      Number(m.mention_quality_score || 0) >= minMentionQualityScore
  );

  const results = await priceMentions(mentions, NARRATIVE_WINDOWS, provider);
  // priceMentions preserves order, so zip narrative fields back onto each result.
  const priced = results.map((r, i) => ({
    ...r,
    direction: mentions[i].direction,
    asset_type: mentions[i].asset_type,
    mention_type: mentions[i].mention_type,
    mention_id: mentions[i].id,
  }));

  let enriched;
  if (kind === 'theme') {
    const themeMap = getMentionThemeMap(TAXONOMY_VERSION);
    // Expand each priced result into one row per theme it carries.
    enriched = [];
    for (const r of priced) {
      for (const theme of themeMap.get(r.mention_id) || []) {
        enriched.push({ ...r, narrative: theme });
      }
    }
  } else {
    enriched = priced.map((r) => ({ ...r, narrative: r.mention_type }));
  }

  const metrics = aggregateByNarrative(enriched);
  replaceNarrativeAlphaMetrics(kind, metrics);

  log.info(
    'narrative-impact',
    `Narrative refresh (${kind}): ${mentions.length} mentions → ${enriched.length} tagged rows → ${metrics.length} groups`
  );
  return metrics;
}

/**
 * Drill-down for a single narrative group: the constituent mentions (which
 * stock, in which video, on which channel, and how far the asset moved) plus a
 * stat block recomputed over just the (optionally filtered) subset. This mirrors
 * the selection logic in `refreshNarrativeImpact` so the numbers agree with the
 * stored aggregate, then prices only the matched subset — cheap and served from
 * the bar cache, no LLM tokens.
 *
 * `channelId` / `videoId` / `minQuality` / `since` are the live filters; the
 * returned `stats.by_window` reflects them so the UI's impact summary moves as
 * the user narrows the set. `filterOptions` lists the channels/videos present in
 * the group *before* the channel/video filters, to populate the dropdowns.
 */
export async function listNarrativeConstituents({
  kind = 'mention_type',
  narrative,
  direction,
  assetType,
  channelId,
  videoId,
  minQuality = 0,
  since,
  provider = alpacaPriceProvider,
  limit = 5000,
} = {}) {
  const themeMap = kind === 'theme' ? getMentionThemeMap(TAXONOMY_VERSION) : null;

  // Same base guard as refreshNarrativeImpact, then narrow to this group.
  const inGroup = listAssetMentions({ limit }).filter((m) => {
    if (!m.mention_type || !GROUPABLE_DIRECTIONS.has(m.direction)) return false;
    if (direction != null && m.direction !== direction) return false;
    if (assetType != null && m.asset_type !== assetType) return false;
    if (kind === 'theme') return (themeMap.get(m.id) || []).includes(narrative);
    return m.mention_type === narrative;
  });

  // Channels/videos in the group before channel/video filtering, for the dropdowns.
  const filterOptions = collectFilterOptions(inGroup);

  const sinceMs = since ? Date.parse(since) : null;
  const filtered = inGroup.filter((m) => {
    if (channelId != null && String(m.channel_id) !== String(channelId)) return false;
    if (videoId != null && String(m.video_id) !== String(videoId)) return false;
    if (Number(m.mention_quality_score || 0) < Number(minQuality || 0)) return false;
    if (sinceMs != null && !Number.isNaN(sinceMs)) {
      const t = m.event_time ? Date.parse(m.event_time) : NaN;
      if (Number.isNaN(t) || t < sinceMs) return false;
    }
    return true;
  });

  const results = await priceMentions(filtered, NARRATIVE_WINDOWS, provider);
  // priceMentions preserves order, so zip mention context back onto each result.
  const priced = results.map((r, i) => ({ ...r, ...pricedContext(filtered[i]) }));

  const mentions = priced
    .map((r) => ({
      mention_id: r.mention_id,
      symbol: r.symbol,
      asset_type: r.asset_type,
      direction: r.direction,
      mention_quality_score: r.mention_quality_score,
      video_title: r.video_title,
      youtube_video_id: r.youtube_video_id,
      mention_start_seconds: r.mention_start_seconds,
      channel_title: r.channel_title,
      channel_id: r.channel_id,
      video_id: r.video_id,
      event_time: r.event_time,
      summary: r.summary,
      by_window: Object.fromEntries(
        NARRATIVE_WINDOWS.map((w) => [
          w,
          { abnormal_return: r[`abnormal_return_${w}`] ?? null, raw_return: r[`raw_return_${w}`] ?? null },
        ])
      ),
    }))
    // Biggest 7d movers first, so "which stock in which video moved the market" is obvious.
    .sort((a, b) => Math.abs(b.by_window['7d'].abnormal_return ?? 0) - Math.abs(a.by_window['7d'].abnormal_return ?? 0));

  const stats = rawNarrativeMetrics({ narrative, direction, assetType }, priced);
  return { mentions, stats, filterOptions };
}

// Mention fields carried onto each priced result for the drill-down payload.
function pricedContext(m) {
  return {
    mention_id: m.id,
    symbol: m.symbol,
    asset_type: m.asset_type,
    direction: m.direction,
    mention_quality_score: m.mention_quality_score,
    video_title: m.video_title,
    youtube_video_id: m.youtube_video_id,
    mention_start_seconds: m.mention_start_seconds,
    channel_title: m.channel_title,
    channel_id: m.channel_id,
    video_id: m.video_id,
    event_time: m.event_time,
    summary: m.summary,
  };
}

function collectFilterOptions(mentions) {
  const channels = new Map();
  const videos = new Map();
  for (const m of mentions) {
    if (m.channel_id != null && !channels.has(m.channel_id)) {
      channels.set(m.channel_id, { id: m.channel_id, title: m.channel_title || '(unknown channel)' });
    }
    if (m.video_id != null && !videos.has(m.video_id)) {
      videos.set(m.video_id, { id: m.video_id, title: m.video_title || '(unknown video)' });
    }
  }
  const byTitle = (a, b) => String(a.title).localeCompare(String(b.title));
  return { channels: [...channels.values()].sort(byTitle), videos: [...videos.values()].sort(byTitle) };
}
