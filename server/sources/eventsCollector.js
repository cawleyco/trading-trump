import axios from 'axios';
import pRetry from 'p-retry';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import {
  listBillsForEvents,
  listRelatedTickersForSectors,
  listTrackedCommitteesForEvents,
  upsertEvent,
} from '../db.js';
import { sectorsForCommittee, sectorsForPolicyArea } from '../lib/committeeSectors.js';
import { log } from '../logger.js';

const API_BASE = 'https://api.congress.gov/v3';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const electionDates = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '..', 'lib', 'electionDates.json'), 'utf8')
);

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function eventUrl(row = {}) {
  return row.url || row.meetingUrl || row.eventUrl || row.updateDateUrl || null;
}

function meetingCommitteeId(row = {}) {
  const committees = row.committees?.committees || row.committees || row.committee || [];
  const first = Array.isArray(committees) ? committees[0] : committees;
  return row.committeeCode || row.committeeId || first?.systemCode || first?.thomasId || first?.name || null;
}

function meetingTitle(row = {}) {
  return row.title || row.meetingTitle || row.name || row.subject || 'Congressional committee meeting';
}

function meetingDate(row = {}) {
  return row.eventDate || row.meetingDate || row.date || row.startDate || row.updateDate || null;
}

export function normalizeMeetingEvent(row, committees = []) {
  const eventDate = meetingDate(row);
  const title = meetingTitle(row);
  const committeeId = meetingCommitteeId(row);
  if (!eventDate || !title) return null;
  const known = committees.find((c) => c.committee_id === committeeId || c.name === committeeId);
  const sectors = known?.sectors?.length
    ? known.sectors
    : sectorsForCommittee({ committee_id: committeeId, name: title });
  return {
    eventType: 'hearing',
    eventDate: String(eventDate).slice(0, 10),
    title,
    sourceUrl: eventUrl(row),
    committeeId,
    sectors,
    dedupKey: `hearing|${String(eventDate).slice(0, 10)}|${committeeId || ''}|${title}`,
  };
}

export function billActionEvent(bill) {
  const eventDate = bill.latest_action_date;
  if (!eventDate || !bill.title) return null;
  const sectors = bill.sectors?.length ? bill.sectors : sectorsForPolicyArea(bill.policy_area);
  return {
    eventType: 'bill-action',
    eventDate,
    title: `${bill.title}: ${bill.latest_action || 'latest action'}`,
    sourceUrl: bill.source_url,
    committeeId: bill.committees?.[0] || null,
    sectors,
    dedupKey: `bill-action|${bill.bill_id}|${eventDate}|${bill.latest_action || ''}`,
  };
}

export function generateLobbyingDeadlineEvents({ from = todayIso(), daysAhead = 365 } = {}) {
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + daysAhead);
  const years = [start.getUTCFullYear(), start.getUTCFullYear() + 1];
  const rows = [];
  for (const year of years) {
    for (const month of [1, 4, 7, 10]) {
      const date = `${year}-${String(month).padStart(2, '0')}-20`;
      const d = new Date(`${date}T00:00:00Z`);
      if (d < start || d > end) continue;
      rows.push({
        eventType: 'lobbying-deadline',
        eventDate: date,
        title: `Senate LDA quarterly filing deadline (${quarterName(month)})`,
        sourceUrl: 'https://lda.senate.gov/',
        committeeId: null,
        sectors: ['financials', 'healthcare', 'energy', 'defense-aerospace', 'technology'],
        dedupKey: `lobbying-deadline|${date}`,
      });
    }
  }
  return rows;
}

function quarterName(month) {
  if (month === 1) return 'Q4 prior year';
  if (month === 4) return 'Q1';
  if (month === 7) return 'Q2';
  return 'Q3';
}

export function staticElectionEvents({ from = todayIso(), daysAhead = 365 } = {}) {
  const until = addDays(from, daysAhead);
  return electionDates
    .filter((row) => row.date >= from && row.date <= until)
    .map((row) => ({
      eventType: 'election',
      eventDate: row.date,
      title: row.title,
      sourceUrl: row.sourceUrl || null,
      committeeId: null,
      sectors: row.sectors || [],
      dedupKey: `election|${row.date}|${row.title}`,
    }));
}

function withRelatedTickers(event) {
  return {
    ...event,
    relatedTickers: listRelatedTickersForSectors(event.sectors || [], { asOf: event.eventDate }),
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

export async function collectHearingEvents({ from = todayIso(), to = addDays(from, 90), limit = 100 } = {}) {
  if (!config.congressGovApiKey) {
    log.warn('events', 'CONGRESS_GOV_API_KEY not set; skipping hearing events');
    return { skipped: true, reason: 'missing CONGRESS_GOV_API_KEY', stored: 0 };
  }
  const committees = listTrackedCommitteesForEvents();
  if (committees.length === 0) {
    log.warn('events', 'No tracked committees found; skipping hearing events');
    return { skipped: true, reason: 'no tracked committees', stored: 0 };
  }
  const trackedKeys = new Set(committees.flatMap((c) => [c.committee_id, c.name]).filter(Boolean));
  const data = await getJson('/committee-meeting', { fromDateTime: from, toDateTime: to, limit });
  const meetings = data.committeeMeetings || data.committeeMeeting || data.meetings || [];
  let stored = 0;
  for (const meeting of meetings) {
    const event = normalizeMeetingEvent(meeting, committees);
    if (!event) continue;
    if (!event.committeeId || !trackedKeys.has(event.committeeId)) continue;
    upsertEvent(withRelatedTickers(event));
    stored++;
  }
  log.info('events', `Hearing event refresh stored ${stored} events`);
  return { skipped: false, considered: meetings.length, stored };
}

export function collectBillActionEvents({ from = addDays(todayIso(), -14), to = addDays(todayIso(), 90) } = {}) {
  const bills = listBillsForEvents({ from, to });
  let stored = 0;
  for (const bill of bills) {
    const event = billActionEvent(bill);
    if (!event) continue;
    upsertEvent(withRelatedTickers(event));
    stored++;
  }
  log.info('events', `Bill action event refresh stored ${stored} events`);
  return { skipped: false, considered: bills.length, stored };
}

export function collectStaticEvents({ from = todayIso(), daysAhead = 365 } = {}) {
  const events = [
    ...generateLobbyingDeadlineEvents({ from, daysAhead }),
    ...staticElectionEvents({ from, daysAhead }),
  ];
  for (const event of events) upsertEvent(withRelatedTickers(event));
  log.info('events', `Static event refresh stored ${events.length} events`);
  return { skipped: false, stored: events.length };
}

export async function refreshPoliticalEvents({ from = todayIso(), to = addDays(from, 90) } = {}) {
  const results = {};
  try {
    results.hearings = await collectHearingEvents({ from, to });
  } catch (err) {
    log.error('events', `Hearing event refresh failed: ${err.message}`);
    results.hearings = { skipped: true, reason: err.message, stored: 0 };
  }
  try {
    results.billActions = collectBillActionEvents({ from: addDays(from, -14), to });
  } catch (err) {
    log.error('events', `Bill action event refresh failed: ${err.message}`);
    results.billActions = { skipped: true, reason: err.message, stored: 0 };
  }
  try {
    results.static = collectStaticEvents({ from, daysAhead: 365 });
  } catch (err) {
    log.error('events', `Static event refresh failed: ${err.message}`);
    results.static = { skipped: true, reason: err.message, stored: 0 };
  }
  return results;
}
