import axios from 'axios';
import pRetry from 'p-retry';
import { listTradedCompanyMeta, upsertGovContract } from '../db.js';
import { log } from '../logger.js';

const API_URL = 'https://api.usaspending.gov/api/v2/search/spending_by_award/';

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function oneYearAgo() {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - 1);
  return isoDate(d);
}

function amount(row = {}) {
  const n = Number(row.Amount ?? row.amount ?? row.award_amount ?? row.generated_pragmatic_obligation);
  return Number.isFinite(n) ? n : null;
}

export function normalizeContract(row = {}, ticker = null) {
  const id = row['Award ID'] || row.award_id || row.generated_unique_award_id || row.id;
  return {
    contract_id: String(id || ''),
    recipient_name: row['Recipient Name'] || row.recipient_name || row.recipient?.recipient_name || null,
    ticker,
    awarding_agency: row['Awarding Agency'] || row.awarding_agency_name || row.awarding_agency?.toptier_agency?.name || null,
    amount: amount(row),
    action_date: row['Start Date'] || row.action_date || row.period_of_performance_start_date || null,
    source_url: id ? `https://www.usaspending.gov/award/${encodeURIComponent(id)}` : null,
  };
}

async function searchCompany(companyName) {
  const resp = await pRetry(
    () => axios.post(API_URL, {
      filters: {
        time_period: [{ start_date: oneYearAgo(), end_date: isoDate(new Date()) }],
        recipient_search_text: [companyName],
        award_type_codes: ['A', 'B', 'C', 'D'],
      },
      fields: ['Award ID', 'Recipient Name', 'Awarding Agency', 'Amount', 'Start Date'],
      page: 1,
      limit: 25,
      sort: 'Start Date',
      order: 'desc',
    }, { timeout: 60000 }),
    { retries: 2, minTimeout: 2000 }
  );
  return resp.data?.results || [];
}

export async function refreshGovContracts({ limitCompanies = 50 } = {}) {
  const companies = listTradedCompanyMeta().filter((r) => r.company_name).slice(0, limitCompanies);
  if (companies.length === 0) {
    log.warn('contracts', 'No traded company metadata available; skipping contracts refresh');
    return { skipped: true, reason: 'no traded company metadata', stored: 0 };
  }
  let stored = 0;
  for (const company of companies) {
    try {
      const rows = await searchCompany(company.company_name);
      for (const row of rows) {
        const contract = normalizeContract(row, company.ticker);
        if (!contract.contract_id) continue;
        upsertGovContract(contract);
        stored++;
      }
    } catch (err) {
      log.warn('contracts', `Contract lookup failed for ${company.ticker}: ${err.message}`);
    }
  }
  log.info('contracts', `Contract refresh stored ${stored} awards`);
  return { skipped: false, companies: companies.length, stored };
}
