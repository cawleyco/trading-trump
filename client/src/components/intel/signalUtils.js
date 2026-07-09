export function normalizeSignal(signal) {
  const confidence = Number(signal.confidence ?? signal.confidence_score ?? 0)
  const relevance = Number(signal.sentimentClassification?.marketRelevance ?? signal.relevance_score ?? confidence)
  const approved = signal.approved
  let action = 'manual_review'
  if (approved === false) action = 'avoid'
  else if (signal.suggested_action) action = signal.suggested_action
  else if (relevance >= 75 && confidence >= 0.7) action = 'copy_candidate'
  else if (confidence || relevance) action = 'watch'
  else action = 'insufficient_data'

  return {
    id: signal.id,
    title: signal.rationale || signal.decision_reason || `${signal.source || 'Public'} signal for ${signal.ticker || signal.symbol || 'asset'}`,
    sourceType: signal.module_key === 'youtube' || signal.source === 'youtube' ? 'youtube' : signal.source === 'congress' ? 'politician_trade' : signal.source || 'politician_trade',
    sourceName: signal.source_name || signal.channel_title || signal.politician || signal.source || 'Public source',
    assetSymbol: signal.ticker || signal.symbol,
    direction: normalizeDirection(signal.direction),
    action,
    actionabilityScore: Math.round(relevance || confidence * 100 || 0),
    confidenceScore: Math.round(confidence <= 1 ? confidence * 100 : confidence),
    riskScore: signal.risk_score ?? (approved === false ? 78 : 32),
    historicalReturnLabel: signal.historical_return_label || signal.backtest_return || 'Edge not confirmed',
    summary: signal.explanation || signal.decision_reason || signal.rationale || 'Manual review recommended. Historical follow-through should be checked before copying.',
    timestamp: signal.created_at,
    evidenceCount: signal.evidence_count ?? (signal.rawReference ? 2 : 1),
  }
}

function normalizeDirection(direction) {
  const d = String(direction || 'neutral').toLowerCase()
  if (d === 'buy') return 'bullish'
  if (d === 'sell') return 'bearish'
  return d
}
