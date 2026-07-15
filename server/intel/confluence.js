// Cross-source confluence: one ticker, every signal source on one timeline —
// congress trades (with copy scores), finfluencer mentions (with creator
// alpha), Trump-post ticker calls, and political calendar events. The core
// (mergeTimeline / findConfluenceWindows) is pure; the loaders query SQLite
// directly, following crossSignal.js.
import { db } from '../db.js';

const DAY_MS = 86400_000;

// Sources that count toward confluence. Calendar events are context, not a
// directional signal — two hearings never make a "confluence".
export const DIRECTIONAL_KINDS = ['congress', 'youtube', 'trump'];

function json(value, fallback) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function day(ts) {
  return String(ts || '').slice(0, 10);
}

// --- pure core --------------------------------------------------------------

/** Sort merged events newest-first; stable per-source order preserved by ts. */
export function mergeTimeline(...eventLists) {
  return eventLists.flat().filter((e) => e && e.ts)
    .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
}

/**
 * Find windows where >= minSources distinct directional sources fired within
 * windowDays of each other. Overlapping windows merge. Pure.
 * Returns [{ start, end, sources, eventCount }] plus marks the involved
 * events with `confluent: true` (mutates copies, not inputs).
 */
export function findConfluenceWindows(events, { windowDays = 14, minSources = 2 } = {}) {
  const directional = events
    .filter((e) => DIRECTIONAL_KINDS.includes(e.kind) && e.ts)
    .map((e) => ({ ...e, _ms: new Date(day(e.ts) + 'T00:00:00Z').getTime() }))
    .filter((e) => Number.isFinite(e._ms))
    .sort((a, b) => a._ms - b._ms);

  const windows = [];
  const spanMs = windowDays * DAY_MS;
  let lo = 0;
  for (let hi = 0; hi < directional.length; hi++) {
    while (directional[hi]._ms - directional[lo]._ms > spanMs) lo++;
    const inWindow = directional.slice(lo, hi + 1);
    const kinds = new Set(inWindow.map((e) => e.kind));
    if (kinds.size >= minSources) {
      const start = day(new Date(directional[lo]._ms).toISOString());
      const end = day(new Date(directional[hi]._ms).toISOString());
      const last = windows[windows.length - 1];
      if (last && start <= last.end) {
        last.end = end > last.end ? end : last.end;
        last.sources = [...new Set([...last.sources, ...kinds])];
        last.eventKeys = [...new Set([...last.eventKeys, ...inWindow.map((e) => `${e.kind}:${e.id}`)])];
      } else {
        windows.push({ start, end, sources: [...kinds], eventKeys: inWindow.map((e) => `${e.kind}:${e.id}`) });
      }
    }
  }
  return windows.map((w) => ({ start: w.start, end: w.end, sources: w.sources.sort(), eventCount: w.eventKeys.length }));
}

// --- loaders (one per source) -----------------------------------------------

export function congressEventsForTicker(ticker, sinceDay) {
  return db.prepare(
    `SELECT ct.trade_key, ct.politician, ct.ticker, ct.type, ct.disclosure_date, ct.transaction_date,
            ct.amount_range, ts.score, ts.recommendation
     FROM congress_trades ct
     LEFT JOIN trade_scores ts ON ts.trade_key = ct.trade_key
     WHERE ct.ticker = ? AND ct.disclosure_date >= ?
     ORDER BY ct.disclosure_date DESC LIMIT 200`
  ).all(ticker, sinceDay).map((t) => ({
    id: t.trade_key,
    kind: 'congress',
    ts: t.disclosure_date,
    direction: t.type === 'sell' ? 'bearish' : 'bullish',
    summary: `${t.politician} disclosed ${t.type} (traded ${t.transaction_date ?? 'n/a'}, ${t.amount_range ?? 'amount n/a'})`,
    score: t.score ?? null,
    context: { recommendation: t.recommendation ?? null },
  }));
}

export function youtubeEventsForTicker(ticker, sinceDay) {
  return db.prepare(
    `SELECT am.id, am.event_time, am.channel_id, yc.title AS channel_title, yv.title AS video_title,
            mc.direction, mc.mention_type, mc.mention_quality_score, mc.pump_risk_score, mc.summary,
            (SELECT label FROM creator_alpha_metrics cam WHERE cam.channel_id = am.channel_id
             ORDER BY cam.calculated_at DESC, cam.id DESC LIMIT 1) AS creator_label,
            (SELECT alpha_score FROM creator_alpha_metrics cam WHERE cam.channel_id = am.channel_id
             ORDER BY cam.calculated_at DESC, cam.id DESC LIMIT 1) AS creator_alpha
     FROM asset_mentions am
     JOIN assets a ON a.id = am.asset_id
     LEFT JOIN youtube_channels yc ON yc.id = am.channel_id
     LEFT JOIN youtube_videos yv ON yv.id = am.video_id
     LEFT JOIN mention_classifications mc ON mc.id = (
       SELECT id FROM mention_classifications WHERE mention_id = am.id ORDER BY id DESC LIMIT 1
     )
     WHERE a.symbol = ? AND am.event_time >= ?
     ORDER BY am.event_time DESC LIMIT 200`
  ).all(ticker, sinceDay).map((m) => ({
    id: m.id,
    kind: 'youtube',
    ts: m.event_time,
    direction: m.direction ?? null,
    summary: `${m.channel_title || 'Creator'}: ${m.summary || `mentioned in "${m.video_title || 'video'}"`}`,
    score: m.mention_quality_score ?? null,
    context: {
      pumpRisk: m.pump_risk_score ?? null,
      mentionType: m.mention_type ?? null,
      creatorLabel: m.creator_label ?? null,
      creatorAlpha: m.creator_alpha ?? null,
    },
  }));
}

export function trumpEventsForTicker(ticker, sinceDay) {
  // classification JSON: { tickers: [{ ticker, direction, confidence }] }
  return db.prepare(
    `SELECT sp.post_id, sp.text, sp.created_at, sp.classification, json_extract(je.value, '$.direction') AS direction,
            json_extract(je.value, '$.confidence') AS confidence
     FROM seen_posts sp, json_each(json_extract(sp.classification, '$.tickers')) je
     WHERE json_extract(je.value, '$.ticker') = ? AND sp.created_at >= ?
     ORDER BY sp.created_at DESC LIMIT 100`
  ).all(ticker, sinceDay).map((p) => ({
    id: p.post_id,
    kind: 'trump',
    ts: p.created_at,
    direction: p.direction === 'sell' || p.direction === 'bearish' ? 'bearish' : 'bullish',
    summary: `Post called ${ticker} (confidence ${p.confidence ?? 'n/a'}): "${String(p.text || '').slice(0, 120)}"`,
    score: p.confidence != null ? Math.round(Number(p.confidence) * 100) : null,
    context: {},
  }));
}

export function calendarEventsForTicker(ticker, sinceDay) {
  return db.prepare(
    `SELECT e.id, e.event_type, e.event_date, e.title
     FROM events e, json_each(COALESCE(e.related_tickers, '[]')) je
     WHERE je.value = ? AND e.event_date >= ?
     ORDER BY e.event_date DESC LIMIT 50`
  ).all(ticker, sinceDay).map((e) => ({
    id: e.id,
    kind: 'calendar',
    ts: e.event_date,
    direction: null,
    summary: `${e.event_type}: ${e.title}`,
    score: null,
    context: {},
  }));
}

// --- assembly ----------------------------------------------------------------

export function buildAssetTimeline(ticker, { days = 90, windowDays = 14, minSources = 2 } = {}) {
  const symbol = String(ticker || '').toUpperCase();
  if (!symbol) throw new Error('ticker is required');
  const sinceDay = day(new Date(Date.now() - days * DAY_MS).toISOString());

  const events = mergeTimeline(
    congressEventsForTicker(symbol, sinceDay),
    youtubeEventsForTicker(symbol, sinceDay),
    trumpEventsForTicker(symbol, sinceDay),
    calendarEventsForTicker(symbol, sinceDay)
  );
  const confluenceWindows = findConfluenceWindows(events, { windowDays, minSources });
  const inWindow = (e) => confluenceWindows.some((w) => day(e.ts) >= w.start && day(e.ts) <= w.end);
  const meta = db.prepare(`SELECT ticker, company_name AS name, sector FROM ticker_meta WHERE ticker = ?`).get(symbol) || null;

  const counts = {};
  for (const e of events) counts[e.kind] = (counts[e.kind] || 0) + 1;

  return {
    ticker: symbol,
    meta,
    days,
    windowDays,
    minSources,
    counts,
    confluenceWindows,
    events: events.map((e) => ({ ...e, confluent: DIRECTIONAL_KINDS.includes(e.kind) && inWindow(e) })),
  };
}

/**
 * Distinct directional sources active for `ticker` within windowDays of
 * `onDay` (inclusive). Used by alert dispatchers to attach confluence context
 * without pulling the whole timeline.
 */
export function confluenceSourcesForTicker(ticker, onDay, windowDays = 14) {
  const symbol = String(ticker || '').toUpperCase();
  const since = day(new Date(new Date(`${day(onDay)}T00:00:00Z`).getTime() - windowDays * DAY_MS).toISOString());
  const until = day(onDay);
  const sources = new Set();
  if (db.prepare(`SELECT 1 FROM congress_trades WHERE ticker = ? AND disclosure_date BETWEEN ? AND ? LIMIT 1`).get(symbol, since, until)) {
    sources.add('congress');
  }
  if (db.prepare(
    `SELECT 1 FROM asset_mentions am JOIN assets a ON a.id = am.asset_id
     WHERE a.symbol = ? AND substr(am.event_time, 1, 10) BETWEEN ? AND ? LIMIT 1`
  ).get(symbol, since, until)) {
    sources.add('youtube');
  }
  if (db.prepare(
    `SELECT 1 FROM seen_posts sp, json_each(json_extract(sp.classification, '$.tickers')) je
     WHERE json_extract(je.value, '$.ticker') = ? AND substr(sp.created_at, 1, 10) BETWEEN ? AND ? LIMIT 1`
  ).get(symbol, since, until)) {
    sources.add('trump');
  }
  return [...sources].sort();
}
