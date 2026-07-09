import axios from 'axios';
import pRetry from 'p-retry';
import { listTradedCompanyMeta, upsertLobbyingFiling } from '../db.js';
import { log } from '../logger.js';
import { resolveTicker } from './tickerMeta.js';

const API_BASE = 'https://lda.senate.gov/api/v1';

function recentFilingPeriods(now = new Date()) {
  const periods = [];
  let year = now.getUTCFullYear();
  let quarter = Math.floor(now.getUTCMonth() / 3) + 1;
  for (let i = 0; i < 2; i++) {
    periods.push(`${year}-Q${quarter}`);
    quarter -= 1;
    if (quarter === 0) {
      quarter = 4;
      year -= 1;
    }
  }
  return periods;
}

function issuesFromRow(row = {}) {
  const activities = row.lobbying_activities || row.activities || [];
  if (!Array.isArray(activities)) return [];
  return [...new Set(activities.map((a) => a.general_issue_code || a.issue_code || a.issue).filter(Boolean))];
}

function amountFromRow(row = {}) {
  const raw = row.income || row.expenses || row.amount || row.reported_amount;
  if (raw == null || raw === '') return null;
  const n = Number(String(raw).replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : null;
}

export function normalizeLobbyingFiling(row = {}, fallbackTicker = null) {
  const clientName = row.client?.name || row.client_name || row.client || null;
  const ticker = fallbackTicker || (clientName ? resolveTicker(clientName) : null);
  return {
    filing_id: String(row.filing_uuid || row.uuid || row.id || row.filing_id || ''),
    client_name: clientName,
    registrant_name: row.registrant?.name || row.registrant_name || row.registrant || null,
    ticker,
    amount: amountFromRow(row),
    filing_period: row.filing_period || row.period || null,
    filed_at: row.filing_date || row.filed_at || row.received || null,
    issues: issuesFromRow(row),
    source_url: row.url || row.filing_url || (row.filing_uuid ? `https://lda.senate.gov/filings/public/filing/${row.filing_uuid}/print/` : null),
  };
}

async function listFilings(params) {
  const resp = await pRetry(
    () => axios.get(`${API_BASE}/filings/`, { params, timeout: 60000 }),
    { retries: 2, minTimeout: 2000 }
  );
  return resp.data?.results || resp.data || [];
}

export async function refreshLobbyingFilings({ limitCompanies = 50 } = {}) {
  const companies = listTradedCompanyMeta().filter((r) => r.company_name).slice(0, limitCompanies);
  if (companies.length === 0) {
    log.warn('lobbying', 'No traded company metadata available; skipping lobbying refresh');
    return { skipped: true, reason: 'no traded company metadata', stored: 0 };
  }
  let stored = 0;
  for (const company of companies) {
    for (const period of recentFilingPeriods()) {
      try {
        const rows = await listFilings({ client_name: company.company_name, filing_period: period, page_size: 25 });
        for (const row of rows) {
          const filing = normalizeLobbyingFiling(row, company.ticker);
          if (!filing.filing_id) continue;
          upsertLobbyingFiling(filing);
          stored++;
        }
      } catch (err) {
        log.warn('lobbying', `Lobbying lookup failed for ${company.ticker}: ${err.message}`);
      }
    }
  }
  log.info('lobbying', `Lobbying refresh stored ${stored} filings`);
  return { skipped: false, companies: companies.length, stored };
}
