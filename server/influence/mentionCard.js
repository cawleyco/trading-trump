// Mention cards: deterministic, thesis-card-shaped explanations of a YouTube
// mention — what happened, why it might matter, what the risks are, and a
// suggested action. Pure assembly from rows the caller already has; missing
// data omits sentences (never "undefined"). Zero LLM, mirroring
// server/intel/thesisCard.js.

const DAY_MS = 86400_000;

function oneLine(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

function pct(v, digits = 1) {
  return v == null ? null : `${v >= 0 ? '+' : ''}${Number(v).toFixed(digits)}%`;
}

export function mentionSuggestedAction(mention, alpha = null) {
  const quality = Number(mention.mention_quality_score || 0);
  const pump = Number(mention.pump_risk_score || 0);
  if (pump >= 70) return 'avoid';
  if (alpha?.label === 'fade') return 'fade-candidate';
  if (alpha?.label === 'follow' && quality >= 70) return 'copy_candidate';
  if (quality >= 70) return 'watch';
  return 'manual_review';
}

/**
 * Build the card. `mention` is a listAssetMentions row (classification fields
 * joined); `alpha` is the creator's latest creator_alpha_metrics row or null.
 */
export function buildMentionCard(mention, alpha = null, { now = Date.now } = {}) {
  const symbol = mention.symbol;
  const creator = mention.channel_title || 'A tracked creator';
  const direction = mention.direction || 'unclassified';
  const mentionType = mention.mention_type ? mention.mention_type.replace(/_/g, ' ') : null;
  const day = String(mention.event_time || '').slice(0, 10);

  const what = oneLine(
    `${creator} mentioned ${symbol} (${direction}${mentionType ? `, ${mentionType}` : ''})` +
      `${mention.video_title ? ` in "${mention.video_title}"` : ''}${day ? ` on ${day}` : ''}.`
  );

  const whyItMatters = [];
  if (alpha?.label === 'follow') {
    whyItMatters.push(oneLine(
      `Proven-alpha creator: ${Math.round(alpha.alpha_score)}th percentile over ${alpha.measurable_mentions} measurable mentions` +
        `${alpha.avg_return_30d != null ? ` (avg 30d ${pct(alpha.avg_return_30d)}` : ''}` +
        `${alpha.win_rate_30d != null ? `, win rate ${Math.round(alpha.win_rate_30d * 100)}%)` : alpha.avg_return_30d != null ? ')' : ''}.`
    ));
  }
  if (alpha?.label === 'fade') {
    whyItMatters.push(oneLine(
      `Fade candidate: this creator's calls have historically been wrong or pump-prone ` +
        `(avg 30d ${pct(alpha.avg_return_30d) ?? 'n/a'}, pump-dump rate ${alpha.pump_dump_rate != null ? `${Math.round(alpha.pump_dump_rate * 100)}%` : 'n/a'} ` +
        `over ${alpha.measurable_mentions} measurable mentions) — a contrarian read, not a buy signal.`
    ));
  }
  if (Number(mention.mention_quality_score) >= 70) {
    whyItMatters.push(`Mention quality ${Math.round(mention.mention_quality_score)}/100 — direct, high-conviction, on-topic.`);
  }
  if (Number(mention.conviction_score) >= 70 && Number(mention.mention_quality_score) < 70) {
    whyItMatters.push(`Creator conviction ${Math.round(mention.conviction_score)}/100.`);
  }
  if (mention.summary) whyItMatters.push(oneLine(mention.summary));

  const risks = [];
  if (Number(mention.pump_risk_score) >= 40) {
    risks.push(`Pump risk ${Math.round(mention.pump_risk_score)}/100${Number(mention.pump_risk_score) >= 70 ? ' — hype-pattern language detected' : ''}.`);
  }
  if (!alpha || alpha.label === 'insufficient_data' || alpha.alpha_score == null) {
    risks.push(
      `Creator track record unproven: ${alpha?.alpha_basis || 'no alpha computed yet'} — this mention carries no historical edge.`
    );
  }
  if (Number(mention.entity_confidence) < 0.75) {
    risks.push(`Entity match confidence ${Number(mention.entity_confidence ?? 0).toFixed(2)} — the ticker may be misidentified.`);
  }
  const ageDays = mention.event_time ? Math.floor((now() - new Date(mention.event_time).getTime()) / DAY_MS) : null;
  if (ageDays != null && ageDays >= 3) {
    risks.push(`Mention is ${ageDays} days old — any immediate move has likely already happened.`);
  }
  if (mention.mention_type === 'sponsored_promotion') {
    risks.push('Flagged as sponsored promotion — the creator is being paid to say this.');
  }

  return {
    symbol,
    mentionId: mention.id,
    what,
    whyItMatters,
    risks,
    suggestedAction: mentionSuggestedAction(mention, alpha),
    creatorLabel: alpha?.label ?? null,
  };
}

/** Compact one-liner for alerts, mirroring tradeAlertMessage's shape. */
export function mentionAlertMessage(mention, alpha = null) {
  const card = buildMentionCard(mention, alpha);
  const quality = Number.isFinite(Number(mention.mention_quality_score))
    ? `[q${Math.round(Number(mention.mention_quality_score))}/100] `
    : '';
  const why = card.whyItMatters[0] ? `${card.whyItMatters[0]} ` : '';
  return oneLine(`${quality}${card.what} ${why}Action: ${card.suggestedAction}.`);
}
