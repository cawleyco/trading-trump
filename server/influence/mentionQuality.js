function clamp(n, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number(n) || 0));
}

export function mentionQualityScore({
  directnessScore = 0,
  convictionScore = 0,
  relevanceScore = 0,
  creatorAlphaScore = 0,
  engagementVelocityScore = 0,
  freshnessScore = 70,
  liquidityScore = 60,
  sponsorshipRiskScore = 0,
  pumpRiskScore = 0,
} = {}) {
  return clamp(
    0.20 * directnessScore +
    0.20 * convictionScore +
    0.15 * relevanceScore +
    0.10 * creatorAlphaScore +
    0.10 * engagementVelocityScore +
    0.10 * freshnessScore +
    0.10 * liquidityScore -
    0.15 * sponsorshipRiskScore -
    0.10 * pumpRiskScore
  );
}

export function qualityLabel(score) {
  const s = clamp(score);
  if (s <= 30) return 'ignore';
  if (s <= 50) return 'weak mention';
  if (s <= 70) return 'watch';
  if (s <= 85) return 'strong signal';
  return 'high-impact signal';
}
