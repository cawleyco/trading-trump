import { SECTORS } from './sicSectors.js';

const KNOWN_SECTORS = new Set(SECTORS);

const COMMITTEE_RULES = [
  [/armed services|intelligence/i, ['defense-aerospace', 'technology']],
  [/homeland security/i, ['defense-aerospace', 'technology']],
  [/veterans/i, ['healthcare', 'defense-aerospace']],
  [/energy.*commerce|commerce.*energy/i, ['energy', 'healthcare', 'communications', 'technology']],
  [/energy|natural resources|environment/i, ['energy', 'materials', 'utilities']],
  [/financial services|banking|finance|ways and means|budget|appropriations/i, ['financials', 'healthcare']],
  [/agriculture/i, ['consumer', 'materials']],
  [/judiciary/i, ['technology', 'communications']],
  [/health|education|labor|help/i, ['healthcare', 'consumer']],
  [/transportation|infrastructure|public works/i, ['industrials', 'materials']],
  [/science|space|technology/i, ['technology', 'defense-aerospace']],
  [/small business/i, ['consumer', 'financials']],
  [/commerce|manufacturing|trade/i, ['industrials', 'consumer', 'technology']],
  [/foreign affairs|foreign relations|rules|administration|ethics|oversight/i, []],
];

const POLICY_AREA_RULES = [
  [/health|medicare|medicaid|drug|veteran/i, ['healthcare']],
  [/tax|bank|finance|securities|housing/i, ['financials', 'real-estate']],
  [/energy|oil|gas|mining|climate|water|environment/i, ['energy', 'materials', 'utilities']],
  [/defense|armed forces|homeland|intelligence|space/i, ['defense-aerospace', 'technology']],
  [/transportation|infrastructure|aviation|rail|shipping/i, ['industrials']],
  [/telecom|media|internet|technology|science|cyber|privacy|antitrust/i, ['technology', 'communications']],
  [/agriculture|food|nutrition|retail|consumer/i, ['consumer', 'materials']],
  [/real estate|housing|mortgage/i, ['real-estate', 'financials']],
];

export const LOBBYING_ISSUE_SECTORS = {
  ACC: ['financials'],
  ADV: ['consumer'],
  AER: ['defense-aerospace', 'industrials'],
  AGR: ['consumer', 'materials'],
  APP: ['financials'],
  AVI: ['industrials', 'defense-aerospace'],
  BAN: ['financials'],
  BUD: ['financials'],
  CHM: ['materials'],
  CIV: ['other'],
  COM: ['communications', 'technology'],
  CPT: ['technology'],
  DEF: ['defense-aerospace'],
  EDU: ['consumer'],
  ENG: ['energy', 'utilities'],
  ENV: ['energy', 'materials', 'utilities'],
  FIN: ['financials'],
  FOO: ['consumer'],
  FOR: ['materials'],
  FUE: ['energy'],
  GOV: ['other'],
  HCR: ['healthcare'],
  HOU: ['real-estate', 'financials'],
  IMM: ['other'],
  INS: ['financials'],
  LBR: ['consumer'],
  MAN: ['industrials'],
  MAR: ['industrials'],
  MED: ['healthcare'],
  MMM: ['materials'],
  NAT: ['energy', 'materials'],
  PHA: ['healthcare'],
  RES: ['other'],
  RET: ['consumer'],
  SCI: ['technology'],
  SMB: ['consumer', 'financials'],
  TAX: ['financials'],
  TEC: ['technology'],
  TOB: ['consumer'],
  TOR: ['financials'],
  TRD: ['consumer', 'industrials'],
  TRU: ['industrials'],
  URB: ['real-estate'],
  UTI: ['utilities'],
};

export const AGENCY_COMMITTEE_KEYWORDS = [
  [/defense|army|navy|air force|space force|darpa|nasa/i, /armed services|science|space|technology|intelligence/i],
  [/energy|interior|environment|epa/i, /energy|natural resources|environment/i],
  [/health|hhs|medicare|veterans/i, /health|ways and means|finance|veterans/i],
  [/transportation|faa|rail|maritime/i, /transportation|commerce/i],
  [/treasury|sec|fdic|federal reserve|housing/i, /financial services|banking|finance|ways and means/i],
  [/homeland|fema|customs|tsa|cyber/i, /homeland security|intelligence|technology/i],
];

function uniqueSectors(values) {
  return [...new Set(values)].filter((sector) => KNOWN_SECTORS.has(sector));
}

function sectorsFromRules(value, rules) {
  const text = String(value || '');
  return uniqueSectors(rules.flatMap(([re, sectors]) => (re.test(text) ? sectors : [])));
}

export function sectorsForCommittee(committee = {}) {
  return sectorsFromRules(`${committee.name || ''} ${committee.committee_id || ''}`, COMMITTEE_RULES);
}

export function sectorsForPolicyArea(value) {
  return sectorsFromRules(value, POLICY_AREA_RULES);
}

export function sectorsForLobbyingIssues(issues = []) {
  return uniqueSectors(
    issues.flatMap((issue) => LOBBYING_ISSUE_SECTORS[String(issue || '').toUpperCase()] || [])
  );
}

export function committeeOverseesAgency(committee, agency) {
  const committeeText = `${committee?.name || ''} ${committee?.committee_id || ''}`;
  const agencyText = String(agency || '');
  return AGENCY_COMMITTEE_KEYWORDS.some(([agencyRe, committeeRe]) =>
    agencyRe.test(agencyText) && committeeRe.test(committeeText)
  );
}
