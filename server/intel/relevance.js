import { db } from '../db.js';
import { getSectorForTicker } from '../sources/tickerMeta.js';
import { committeeOverseesAgency, sectorsForLobbyingIssues } from '../lib/committeeSectors.js';

function json(value, fallback) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function daysBetween(a, b) {
  if (!a || !b) return null;
  const d1 = new Date(`${String(a).slice(0, 10)}T00:00:00Z`);
  const d2 = new Date(`${String(b).slice(0, 10)}T00:00:00Z`);
  const diff = Math.round((d2 - d1) / 86400_000);
  return Number.isFinite(diff) ? diff : null;
}

function withinDays(date, basis, days) {
  const diff = daysBetween(date, basis);
  return diff != null && diff >= 0 && diff <= days;
}

function basisDate(trade) {
  return trade.disclosure_date || trade.transaction_date || new Date().toISOString().slice(0, 10);
}

function getCommittees(bioguideId) {
  if (!bioguideId) return [];
  return db
    .prepare(
      `SELECT c.*, cm.role
       FROM committee_memberships cm
       JOIN committees c ON c.committee_id = cm.committee_id
       WHERE cm.bioguide_id = ?`
    )
    .all(bioguideId)
    .map((row) => ({ ...row, sectors: json(row.sectors, []) }));
}

function getTickerMeta(ticker) {
  return db.prepare(`SELECT * FROM ticker_meta WHERE ticker = ?`).get(String(ticker || '').toUpperCase()) || null;
}

function getRecentBills(basis) {
  return db
    .prepare(
      `SELECT * FROM bills
       WHERE latest_action_date >= date(?, '-90 days')
         AND latest_action_date <= date(?)
       ORDER BY latest_action_date DESC`
    )
    .all(basis, basis)
    .map((row) => ({
      ...row,
      committees: json(row.committees, []),
      sectors: json(row.sectors, []),
    }));
}

function getRecentLobbying(ticker, basis) {
  return db
    .prepare(
      `SELECT * FROM lobbying_filings
       WHERE ticker = ?
         AND filed_at >= date(?, '-180 days')
         AND filed_at <= date(?)
       ORDER BY filed_at DESC`
    )
    .all(ticker, basis, basis)
    .map((row) => ({ ...row, issues: json(row.issues, []) }));
}

function getRecentContracts(ticker, basis) {
  return db
    .prepare(
      `SELECT * FROM gov_contracts
       WHERE ticker = ?
         AND action_date >= date(?, '-180 days')
         AND action_date <= date(?)
       ORDER BY action_date DESC`
    )
    .all(ticker, basis, basis);
}

function highestRole(committees) {
  if (committees.some((c) => ['chair', 'ranking member'].includes(c.role))) return committees.find((c) => ['chair', 'ranking member'].includes(c.role))?.role;
  return null;
}

export async function computeRelevance(trade, opts = {}) {
  const basis = opts.basisDate || basisDate(trade);
  const committees = opts.committees ?? getCommittees(trade.politician_id);
  const tickerMeta = opts.tickerMeta ?? getTickerMeta(trade.ticker);
  const tickerSector = opts.tickerSector ?? tickerMeta?.sector ?? await getSectorForTicker(trade.ticker);
  const committeeSectors = new Set(committees.flatMap((c) => c.sectors || []));
  const signals = [];

  if (!trade.politician_id) {
    return { score: 0, signals: [], hasData: false, detail: 'No Bioguide ID linked for this filing politician.' };
  }

  if (tickerSector && committeeSectors.has(tickerSector)) {
    const matching = committees.filter((c) => (c.sectors || []).includes(tickerSector));
    signals.push({
      type: 'committee-sector',
      points: 40,
      text: `${trade.politician} sits on ${matching.map((c) => c.name).slice(0, 2).join(', ')}, which maps to ${tickerSector}.`,
      source: matching.map((c) => ({ committee_id: c.committee_id, name: c.name, role: c.role })),
    });
    const role = highestRole(matching);
    if (role) {
      signals.push({
        type: 'committee-leadership',
        points: 10,
        text: `${trade.politician} has ${role} influence on a ${tickerSector}-relevant committee.`,
      });
    }
  }

  const committeeIds = new Set(committees.map((c) => c.committee_id));
  const bills = opts.bills ?? getRecentBills(basis);
  const bill = bills.find((b) =>
    (tickerSector && (b.sectors || []).includes(tickerSector)) &&
    (b.committees || []).some((id) => committeeIds.has(id)) &&
    withinDays(b.latest_action_date, basis, 90)
  );
  if (bill) {
    signals.push({
      type: 'active-bill-overlap',
      points: 20,
      text: `Recent bill activity overlaps ${tickerSector}: ${bill.title || bill.bill_id}.`,
      source: { bill_id: bill.bill_id, latest_action_date: bill.latest_action_date, source_url: bill.source_url },
    });
  }

  const lobbying = opts.lobbyingFilings ?? getRecentLobbying(trade.ticker, basis);
  const filing = lobbying.find((l) => withinDays(l.filed_at, basis, 180));
  if (filing) {
    signals.push({
      type: 'recent-lobbying',
      points: 15,
      text: `${filing.client_name || trade.ticker} had a recent lobbying filing before disclosure.`,
      source: { filing_id: filing.filing_id, filed_at: filing.filed_at, source_url: filing.source_url },
    });
    const issueSectors = sectorsForLobbyingIssues(filing.issues || []);
    if (issueSectors.some((sector) => committeeSectors.has(sector))) {
      signals.push({
        type: 'lobbying-committee-issue',
        points: 10,
        text: `Lobbying issue areas overlap the politician's committee sectors (${issueSectors.join(', ')}).`,
      });
    }
  }

  const contracts = opts.contracts ?? getRecentContracts(trade.ticker, basis);
  const contract = contracts.find((c) =>
    withinDays(c.action_date, basis, 180) &&
    committees.some((committee) => committeeOverseesAgency(committee, c.awarding_agency))
  );
  if (contract) {
    signals.push({
      type: 'recent-contract',
      points: 15,
      text: `${trade.ticker} had a recent federal contract from ${contract.awarding_agency}.`,
      source: { contract_id: contract.contract_id, action_date: contract.action_date, source_url: contract.source_url },
    });
  }

  const score = Math.min(100, signals.reduce((sum, s) => sum + s.points, 0));
  return {
    score,
    signals,
    hasData: committees.length > 0 || Boolean(tickerSector),
    tickerSector: tickerSector || null,
    committeeSectors: [...committeeSectors],
  };
}
