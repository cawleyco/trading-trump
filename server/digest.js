// Morning brief: one message each weekday morning answering "what should I
// look at today?" — overnight finfluencer mentions from tracked creators
// (with follow/fade labels), new high-score congress trades, tickers with
// active cross-source confluence, and pump warnings on positions you hold.
// buildMorningDigest is pure (fixture-testable); collectDigestData does the
// queries; runMorningDigest persists + notifies.
import { config } from './config.js';
import { db, upsertDigest } from './db.js';
import { confluenceSourcesForTicker } from './intel/confluence.js';
import { heldTickers } from './intel/alertEngine.js';
import { notify } from './notifier.js';
import { log } from './logger.js';

function day(ts) {
  return String(ts || '').slice(0, 10);
}

// --- pure assembly -----------------------------------------------------------

function line(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

/**
 * Pure: assemble the digest from pre-queried rows. Empty sections are elided —
 * a quiet night produces an empty sections array, not filler.
 * data: { date, mentions, trades, confluences, pumpWarnings }
 */
export function buildMorningDigest(data) {
  const sections = [];

  // One creator hammering one ticker nine times is one line with a count,
  // not nine lines — group by (symbol, creator, direction).
  const grouped = new Map();
  for (const m of data.mentions || []) {
    const key = `${m.symbol}|${m.channel_title}|${m.direction}`;
    const cur = grouped.get(key);
    if (cur) {
      cur.count++;
      cur.mention_quality_score = Math.max(cur.mention_quality_score ?? 0, m.mention_quality_score ?? 0);
    } else {
      grouped.set(key, { ...m, count: 1 });
    }
  }
  const mentionGroups = [...grouped.values()];
  const follows = mentionGroups.filter((m) => m.creator_label === 'follow');
  const others = mentionGroups.filter((m) => m.creator_label !== 'follow');
  if (mentionGroups.length) {
    const times = (m) => (m.count > 1 ? ` ×${m.count}` : '');
    const items = [
      ...follows.map((m) => line(
        `★ ${m.symbol} ${m.direction ?? ''}${times(m)} — ${m.channel_title} (FOLLOW, alpha ${m.creator_alpha != null ? Math.round(m.creator_alpha) : 'n/a'}), quality ${m.mention_quality_score != null ? Math.round(m.mention_quality_score) : 'n/a'}`
      )),
      ...others.slice(0, 10).map((m) => line(
        `${m.symbol} ${m.direction ?? ''}${times(m)} — ${m.channel_title}${m.creator_label === 'fade' ? ' (FADE — contrarian read)' : ''}${m.creator_label === 'insufficient_data' || !m.creator_label ? ' (unproven creator)' : ''}`
      )),
    ];
    sections.push({
      key: 'mentions',
      title: `Overnight creator mentions (${data.mentions.length})`,
      items,
    });
  }

  if (data.trades?.length) {
    sections.push({
      key: 'trades',
      title: `New high-score congress trades (${data.trades.length})`,
      items: data.trades.map((t) => line(
        `${t.ticker} ${t.type} — ${t.politician} [${Math.round(t.score)}/100 ${t.recommendation ?? ''}] disclosed ${t.disclosure_date}`
      )),
    });
  }

  if (data.confluences?.length) {
    sections.push({
      key: 'confluence',
      title: `Cross-source confluence (${data.confluences.length})`,
      items: data.confluences.map((c) => line(
        `${c.ticker}: ${c.sources.join(' + ')} all active within ${c.windowDays} days`
      )),
    });
  }

  if (data.pumpWarnings?.length) {
    sections.push({
      key: 'pump',
      title: `⚠ Pump warnings on HELD positions (${data.pumpWarnings.length})`,
      items: data.pumpWarnings.map((m) => line(
        `${m.symbol} — pump risk ${Math.round(m.pump_risk_score)}/100 from ${m.channel_title}`
      )),
    });
  }

  const title = `Morning brief — ${data.date}`;
  const plain = sections.length
    ? sections.map((s) => `${s.title}\n${s.items.map((i) => `  • ${i}`).join('\n')}`).join('\n\n')
    : 'Quiet night: no tracked-creator mentions, high-score trades, confluence, or pump warnings.';

  return { date: data.date, title, sections, plain };
}

// --- data collection -----------------------------------------------------------

export async function collectDigestData({ sinceHours = 24, minCopyScore = config.digest.minCopyScore } = {}) {
  const sinceIso = new Date(Date.now() - sinceHours * 3600_000).toISOString();
  const date = day(new Date().toISOString());

  const mentions = db.prepare(
    `SELECT am.id, am.event_time, a.symbol, yc.title AS channel_title,
            mc.direction, mc.mention_quality_score, mc.pump_risk_score,
            (SELECT label FROM creator_alpha_metrics cam WHERE cam.channel_id = am.channel_id
             ORDER BY cam.calculated_at DESC, cam.id DESC LIMIT 1) AS creator_label,
            (SELECT alpha_score FROM creator_alpha_metrics cam WHERE cam.channel_id = am.channel_id
             ORDER BY cam.calculated_at DESC, cam.id DESC LIMIT 1) AS creator_alpha
     FROM asset_mentions am
     JOIN assets a ON a.id = am.asset_id
     JOIN youtube_channels yc ON yc.id = am.channel_id AND yc.tracking_enabled = 1
     LEFT JOIN mention_classifications mc ON mc.id = (
       SELECT id FROM mention_classifications WHERE mention_id = am.id ORDER BY id DESC LIMIT 1
     )
     WHERE am.created_at >= ? AND mc.direction IN ('bullish', 'bearish')
     ORDER BY (creator_label = 'follow') DESC, mc.mention_quality_score DESC
     LIMIT 50`
  ).all(sinceIso);

  const trades = db.prepare(
    `SELECT ct.trade_key, ct.ticker, ct.type, ct.politician, ct.disclosure_date, ts.score, ts.recommendation
     FROM congress_trades ct
     JOIN trade_scores ts ON ts.trade_key = ct.trade_key
     WHERE ct.first_seen_at >= ? AND ts.score >= ?
     ORDER BY ts.score DESC LIMIT 25`
  ).all(sinceIso, minCopyScore);

  // Confluence check over every ticker that moved in the window.
  const activeTickers = [...new Set([...mentions.map((m) => m.symbol), ...trades.map((t) => t.ticker)])];
  const confluences = [];
  for (const ticker of activeTickers.slice(0, 40)) {
    const sources = confluenceSourcesForTicker(ticker, date, 14);
    if (sources.length >= 2) confluences.push({ ticker, sources, windowDays: 14 });
  }

  let pumpWarnings = [];
  try {
    const held = await heldTickers();
    pumpWarnings = mentions.filter(
      (m) => Number(m.pump_risk_score) >= 70 && held.has(String(m.symbol).toUpperCase())
    );
  } catch (err) {
    log.warn('digest', `Held-position check failed: ${err.message}`);
  }

  return { date, mentions, trades, confluences, pumpWarnings };
}

// --- runner --------------------------------------------------------------------

export async function runMorningDigest({ notifyFn = notify } = {}) {
  const data = await collectDigestData();
  const digest = buildMorningDigest(data);
  upsertDigest(digest.date, digest);
  if (digest.sections.length === 0) {
    log.info('digest', `Morning brief ${digest.date}: quiet night, persisted but not notified`);
    return digest;
  }
  try {
    notifyFn(digest.title, digest.plain, { channel: config.digest.channel });
  } catch (err) {
    log.warn('digest', `Digest notify failed: ${err.message}`);
  }
  log.info('digest', `Morning brief ${digest.date}: ${digest.sections.map((s) => s.key).join(', ')}`);
  return digest;
}
