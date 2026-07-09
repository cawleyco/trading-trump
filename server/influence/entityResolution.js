const FINANCIAL_CONTEXT = /\b(stock|shares|company|earnings|revenue|valuation|market cap|calls?|puts?|chart|breakout|support|resistance|portfolio|buying|selling|crypto|token|coin|chain|defi|etf|price|trade|position)\b/i;

const AMBIGUOUS = new Map([
  ['AAPL', /\b(earnings|iphone|ipad|mac|stock|shares|company|market|revenue)\b/i],
  ['SOL', /\b(solana|crypto|token|coin|chain|defi|\$SOL)\b/i],
  ['LINK', /\b(chainlink|crypto|token|oracle|\$LINK)\b/i],
  ['NEAR', /\b(near protocol|crypto|token|\$NEAR)\b/i],
  ['OP', /\b(optimism|crypto|token|layer 2|l2|\$OP)\b/i],
]);

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function resolveAssetMentionsInText(text, aliases) {
  const source = String(text || '');
  const mentions = [];
  const seen = new Set();
  for (const alias of aliases) {
    const asset = {
      id: alias.asset_id,
      symbol: alias.symbol,
      canonical_name: alias.canonical_name,
      asset_type: alias.asset_type,
    };
    const isCashtag = alias.alias.startsWith('$');
    const pattern = isCashtag
      ? new RegExp(`\\${alias.alias}\\b`, 'gi')
      : new RegExp(`\\b${escapeRegex(alias.alias)}\\b`, 'gi');
    for (const match of source.matchAll(pattern)) {
      const mentionText = match[0];
      const start = match.index ?? 0;
      const context = source.slice(Math.max(0, start - 120), Math.min(source.length, start + mentionText.length + 120));
      if (!passesAmbiguityFilter(asset, mentionText, context, isCashtag)) continue;
      const key = `${asset.id}:${start}:${mentionText.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      mentions.push({
        asset,
        mentionText,
        surroundingText: context.trim(),
        entityConfidence: isCashtag ? 0.98 : confidenceFor(asset, mentionText, context),
        detectionMethod: isCashtag ? 'regex' : 'hybrid',
      });
    }
  }
  return mentions;
}

export function passesAmbiguityFilter(asset, mentionText, context, isCashtag = false) {
  if (isCashtag) return true;
  const symbol = String(asset.symbol || '').toUpperCase();
  if (String(mentionText).toUpperCase() === symbol && symbol.length <= 4 && !FINANCIAL_CONTEXT.test(context)) {
    return false;
  }
  const required = AMBIGUOUS.get(symbol);
  if (required && !required.test(context)) return false;
  if (symbol === 'AAPL' && /\b(apple pie|apple juice|ate an apple|green apple|red apple)\b/i.test(context)) {
    return false;
  }
  if (symbol === 'SOL' && /\b(solution|solar|solely)\b/i.test(context) && !/\b(solana|\$SOL)\b/i.test(context)) {
    return false;
  }
  return true;
}

function confidenceFor(asset, mentionText, context) {
  if (String(mentionText).toUpperCase() === String(asset.symbol).toUpperCase()) return 0.82;
  if (FINANCIAL_CONTEXT.test(context)) return 0.9;
  return asset.asset_type === 'crypto' ? 0.8 : 0.76;
}
