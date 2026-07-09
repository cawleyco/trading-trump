import axios from 'axios';
import { log } from '../logger.js';

// Free, official source: efdsearch.senate.gov (Senate electronic Periodic
// Transaction Reports). After accepting the standard access agreement we get
// a session cookie; filings are listed by a JSON endpoint and each e-filed
// PTR renders as an HTML table of transactions. Senate-only — House PTRs are
// PDFs and are covered via Quiver when an API key is configured.

const BASE = 'https://efdsearch.senate.gov';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function parseCookies(setCookieHeaders, jar) {
  for (const h of setCookieHeaders || []) {
    const [pair] = h.split(';');
    const idx = pair.indexOf('=');
    if (idx > 0) jar[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }
}

function cookieHeader(jar) {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

async function openSession() {
  const jar = {};
  const home = await axios.get(`${BASE}/search/`, {
    headers: { 'User-Agent': UA },
    timeout: 30000,
  });
  parseCookies(home.headers['set-cookie'], jar);
  const csrfMatch = home.data.match(/name="csrfmiddlewaretoken" value="([^"]+)"/);
  if (!csrfMatch) throw new Error('Senate eFD: could not find CSRF token on search page');

  // Don't follow the redirect: axios drops set-cookie headers from
  // intermediate responses, and the session cookie is set on the 302 itself.
  const agree = await axios.post(
    `${BASE}/search/home/`,
    new URLSearchParams({ prohibition_agreement: '1', csrfmiddlewaretoken: csrfMatch[1] }),
    {
      headers: {
        'User-Agent': UA,
        Referer: `${BASE}/search/`,
        Cookie: cookieHeader(jar),
      },
      maxRedirects: 0,
      validateStatus: (s) => s < 400,
      timeout: 30000,
    }
  );
  parseCookies(agree.headers['set-cookie'], jar);
  if (!jar.csrftoken) throw new Error('Senate eFD: no csrftoken cookie after agreement');
  return jar;
}

async function listFilings(jar, startDate, endDate) {
  const filings = [];
  const pageSize = 100;
  for (let start = 0; start < 2000; start += pageSize) {
    const payload = new URLSearchParams({
      start: String(start),
      length: String(pageSize),
      report_types: '[11]', // Periodic Transaction Reports
      filer_types: '[]',
      submitted_start_date: `${startDate} 00:00:00`,
      submitted_end_date: endDate ? `${endDate} 23:59:59` : '',
      candidate_state: '',
      senator_state: '',
      office_id: '',
      first_name: '',
      last_name: '',
      csrfmiddlewaretoken: jar.csrftoken,
    });
    const resp = await axios.post(`${BASE}/search/report/data/`, payload, {
      headers: {
        'User-Agent': UA,
        Referer: `${BASE}/search/`,
        Cookie: cookieHeader(jar),
        'X-Requested-With': 'XMLHttpRequest',
      },
      timeout: 30000,
    });
    const rows = resp.data?.data || [];
    for (const row of rows) {
      // row: [first, last, filer type, report link html, filing date]
      const link = String(row[3]).match(/href="(\/search\/view\/ptr\/([0-9a-f-]+)\/)"/);
      if (!link) continue; // paper filing (scanned PDF) — skip
      const dateMatch = String(row[4]).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
      if (!dateMatch) continue;
      // Anchor text is the report title, e.g. "Periodic Transaction Report"
      // or "...(Amendment)" — used downstream to detect amended filings.
      const titleMatch = String(row[3]).match(/>([^<]+)<\/a>/);
      filings.push({
        member: `${row[0]} ${row[1]}`.trim(),
        url: BASE + link[1],
        docId: link[2],
        filingDate: `${dateMatch[3]}-${dateMatch[1]}-${dateMatch[2]}`,
        reportTitle: titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : null,
      });
    }
    if (rows.length < pageSize) break;
  }
  return filings;
}

function parsePtrHtml(html) {
  const body = html.split('<tbody>').pop();
  const trades = [];
  for (const rowMatch of body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...rowMatch[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) =>
      m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim()
    );
    // columns: #, txn date, owner, ticker, asset name, asset type, type, amount, comment
    if (cells.length < 8) continue;
    // The ticker cell is often "--" with the symbol embedded in the asset
    // name instead, e.g. "Citigroup New Inc (C)".
    let ticker = cells[3];
    if (!ticker || ticker === '--') {
      ticker = cells[4].match(/\(([A-Z][A-Z0-9.\-]{0,6})\)\s*$/)?.[1] || '';
    }
    if (!ticker || ticker === '--') continue;
    const dateMatch = cells[1].match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    const typeToken = cells[6].trim().toUpperCase();
    trades.push({
      ticker: ticker.toUpperCase(),
      owner: cells[2],
      assetName: cells[4],
      assetType: cells[5],
      type: typeToken.startsWith('P') ? 'buy' : typeToken.startsWith('S') ? 'sell' : null,
      transactionDate: dateMatch ? `${dateMatch[3]}-${dateMatch[1]}-${dateMatch[2]}` : null,
      amountRange: cells[7],
    });
  }
  return trades.filter((t) => t.type);
}

async function fetchPtr(jar, filing) {
  const resp = await axios.get(filing.url, {
    headers: { 'User-Agent': UA, Referer: `${BASE}/search/`, Cookie: cookieHeader(jar) },
    timeout: 30000,
  });
  return parsePtrHtml(resp.data).map((t) => ({
    politician: filing.member,
    ticker: t.ticker,
    type: t.type,
    transactionDate: t.transactionDate,
    disclosureDate: filing.filingDate,
    amountRange: t.amountRange,
    raw: {
      chamber: 'senate',
      docId: filing.docId,
      url: filing.url,
      owner: t.owner,
      assetName: t.assetName,
      assetType: t.assetType,
      reportTitle: filing.reportTitle,
    },
  }));
}

/**
 * Senate trades disclosed between startDate and endDate (YYYY-MM-DD).
 * maxFilings bounds the per-filing page fetches.
 */
export async function fetchSenateTrades(startDate, endDate = null, maxFilings = 300) {
  const toUs = (iso) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;
  const jar = await openSession();
  let filings = await listFilings(jar, toUs(startDate), endDate ? toUs(endDate) : null);
  filings.sort((a, b) => b.filingDate.localeCompare(a.filingDate));
  filings = filings.slice(0, maxFilings);
  log.info('senate-efd', `Fetching ${filings.length} Senate PTR filings...`);

  const trades = [];
  // Fetch sequentially in small batches to be polite to the official site
  const batchSize = 5;
  for (let i = 0; i < filings.length; i += batchSize) {
    const batch = filings.slice(i, i + batchSize);
    const results = await Promise.allSettled(batch.map((f) => fetchPtr(jar, f)));
    for (const r of results) {
      if (r.status === 'fulfilled') trades.push(...r.value);
    }
  }
  return trades;
}
