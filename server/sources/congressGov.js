import axios from 'axios';
import pRetry from 'p-retry';
import { config } from '../config.js';
import { db, upsertBill } from '../db.js';
import { log } from '../logger.js';
import { sectorsForCommittee, sectorsForPolicyArea } from '../lib/committeeSectors.js';

const API_BASE = 'https://api.congress.gov/v3';

function billId(bill = {}) {
  const congress = bill.congress;
  const type = String(bill.type || '').toLowerCase();
  const number = bill.number;
  if (!congress || !type || !number) return bill.url || null;
  return `${type}${number}-${congress}`;
}

function billUrl(bill = {}) {
  const congress = bill.congress;
  const type = String(bill.type || '').toLowerCase();
  const number = bill.number;
  return congress && type && number
    ? `https://www.congress.gov/bill/${congress}th-congress/${type}-bill/${number}`
    : bill.url || null;
}

function committeeIdsFromBill(bill = {}) {
  const rows = bill.committees?.committees || bill.committees || bill.committeeReports || [];
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => row.systemCode || row.thomasId || row.name)
    .filter(Boolean);
}

function trackedCommitteeSectors() {
  return db.prepare(`SELECT committee_id, name, sectors FROM committees`).all().map((row) => {
    let sectors = [];
    try { sectors = row.sectors ? JSON.parse(row.sectors) : []; } catch { sectors = []; }
    return { ...row, sectors };
  });
}

export function normalizeBill(row, committees = trackedCommitteeSectors()) {
  const committeeIds = committeeIdsFromBill(row);
  const namedCommitteeSectors = committeeIds.flatMap((idOrName) => {
    const known = committees.find((c) => c.committee_id === idOrName || c.name === idOrName);
    return known?.sectors?.length ? known.sectors : sectorsForCommittee({ name: idOrName });
  });
  const policyArea = row.policyArea?.name || row.policy_area || row.policyArea || null;
  const sectors = [...new Set([...namedCommitteeSectors, ...sectorsForPolicyArea(policyArea)])];
  return {
    bill_id: billId(row),
    title: row.title || row.shortTitle || null,
    policy_area: policyArea,
    latest_action: row.latestAction?.text || row.latest_action || null,
    latest_action_date: row.latestAction?.actionDate || row.latest_action_date || row.updateDate || null,
    committees: committeeIds,
    sectors,
    source_url: billUrl(row),
    updated_at: row.updateDate || new Date().toISOString(),
  };
}

async function getJson(path, params = {}) {
  const resp = await pRetry(
    () => axios.get(`${API_BASE}${path}`, {
      params: { ...params, api_key: config.congressGovApiKey },
      timeout: 60000,
    }),
    { retries: 2, minTimeout: 2000 }
  );
  return resp.data;
}

export async function refreshRecentBills({ limit = 100 } = {}) {
  if (!config.congressGovApiKey) {
    log.warn('congress-gov', 'CONGRESS_GOV_API_KEY not set; skipping bill refresh');
    return { skipped: true, reason: 'missing CONGRESS_GOV_API_KEY', stored: 0 };
  }
  const committees = trackedCommitteeSectors();
  const trackedSectors = new Set(committees.flatMap((c) => c.sectors || []));
  const data = await getJson('/bill', { sort: 'updateDate', limit });
  const bills = data.bills || data.bill || [];
  let stored = 0;
  for (const bill of bills) {
    const normalized = normalizeBill(bill, committees);
    if (!normalized.bill_id) continue;
    const relevant = normalized.committees.some((id) => committees.some((c) => c.committee_id === id || c.name === id)) ||
      normalized.sectors.some((sector) => trackedSectors.has(sector));
    if (!relevant && committees.length > 0) continue;
    upsertBill(normalized);
    stored++;
  }
  log.info('congress-gov', `Bill refresh stored ${stored} relevant bills`);
  return { skipped: false, considered: bills.length, stored };
}
