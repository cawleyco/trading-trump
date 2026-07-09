import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import pRetry from 'p-retry';
import yaml from 'yaml';
import { config } from '../config.js';
import {
  addPoliticianNameVariant,
  linkArchivePoliticianName,
  listPoliticianIdentities,
  listUnlinkedArchivePoliticianNames,
  replaceCommitteeMemberships,
  upsertCommittee,
  upsertPolitician,
} from '../db.js';
import { log } from '../logger.js';
import { sectorsForCommittee } from '../lib/committeeSectors.js';
import { POLITICIAN_OVERRIDES } from '../lib/politicianOverrides.js';

const BASE = 'https://raw.githubusercontent.com/unitedstates/congress-legislators/main';
const FILES = {
  legislators: `${BASE}/legislators-current.yaml`,
  committees: `${BASE}/committees-current.yaml`,
  memberships: `${BASE}/committee-membership-current.yaml`,
};
const TTL_MS = 7 * 86400_000;

function cachePath(name) {
  return path.join(config.dataCacheDir, name);
}

function readCache(name) {
  try {
    const file = cachePath(name);
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs > TTL_MS) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function writeCache(name, text) {
  try {
    fs.mkdirSync(config.dataCacheDir, { recursive: true });
    fs.writeFileSync(cachePath(name), text);
  } catch (err) {
    log.warn('legislators', `Failed to write data-cache/${name}: ${err.message}`);
  }
}

async function fetchYaml(name, url) {
  const cacheName = `${name}.yaml`;
  const cached = readCache(cacheName);
  const text = cached || (await pRetry(
    async () => {
      const resp = await axios.get(url, { timeout: 60000, responseType: 'text' });
      return resp.data;
    },
    { retries: 3, minTimeout: 2000 }
  ));
  if (!cached) writeCache(cacheName, text);
  return yaml.parse(text);
}

function currentTerm(legislator) {
  const terms = legislator?.terms || [];
  return terms[terms.length - 1] || {};
}

function fullName(name = {}) {
  return [name.first, name.middle, name.last].filter(Boolean).join(' ');
}

function chamberFromType(type) {
  if (type === 'rep') return 'house';
  if (type === 'sen') return 'senate';
  return type || null;
}

export function normalizePolitician(row) {
  const term = currentTerm(row);
  const name = fullName(row.name);
  const variants = [
    name,
    row.name?.official_full,
    row.name?.nickname && `${row.name.nickname} ${row.name.last}`,
    row.name?.last && row.name?.first && `${row.name.last}, ${row.name.first}`,
  ].filter(Boolean);
  return {
    bioguide_id: row.id?.bioguide,
    full_name: row.name?.official_full || name,
    chamber: chamberFromType(term.type),
    party: term.party || null,
    state: term.state || null,
    name_variants: [...new Set(variants)],
  };
}

function committeeId(row) {
  return row.thomas_id || row.house_committee_id || row.senate_committee_id || row.id || row.code;
}

export function normalizeCommittee(row) {
  const id = committeeId(row);
  return {
    committee_id: id,
    name: row.name,
    chamber: row.type === 'house' || row.type === 'senate' ? row.type : row.chamber || row.type || null,
    sectors: sectorsForCommittee({ committee_id: id, name: row.name }),
  };
}

function flattenCommittees(rows = []) {
  const out = [];
  for (const row of rows) {
    const parent = normalizeCommittee(row);
    if (parent.committee_id && parent.name) out.push(parent);
    for (const sub of row.subcommittees || []) {
      const subId = sub.thomas_id || sub.id || (parent.committee_id && `${parent.committee_id}-${sub.name}`);
      out.push({
        committee_id: subId,
        name: `${parent.name}: ${sub.name}`,
        chamber: parent.chamber,
        sectors: sectorsForCommittee({ committee_id: subId, name: `${parent.name} ${sub.name}` }),
      });
    }
  }
  return out;
}

function roleFor(member = {}) {
  const title = String(member.title || member.rank || member.role || '').toLowerCase();
  if (title.includes('chair')) return 'chair';
  if (title.includes('ranking')) return 'ranking member';
  return 'member';
}

function flattenMemberships(data) {
  const out = [];
  const walk = (node, committee = null) => {
    if (Array.isArray(node)) {
      for (const member of node) {
        const bioguide = member?.bioguide || member?.id?.bioguide || member?.id;
        if (committee && bioguide) {
          out.push({ bioguide_id: bioguide, committee_id: committee, role: roleFor(member) });
        }
      }
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (Array.isArray(value)) walk(value, key);
      else if (value?.members) walk(value.members, key);
      else walk(value, key);
    }
  };
  walk(data);
  return out;
}

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\b(hon|rep|representative|sen|senator|mr|mrs|ms|dr)\.?\b/g, '')
    .replace(/[^a-z,\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function nameCandidates(value) {
  const normalized = normalizeName(value);
  const candidates = new Set([normalized]);
  const parts = normalized.split(',');
  if (parts.length === 2) candidates.add(`${parts[1].trim()} ${parts[0].trim()}`.replace(/\s+/g, ' '));
  return [...candidates].filter(Boolean);
}

function lastName(value) {
  const n = normalizeName(value).replace(',', ' ');
  return n.split(/\s+/).filter(Boolean).at(-1) || '';
}

export function matchPoliticianName(name, identities = listPoliticianIdentities()) {
  const override = POLITICIAN_OVERRIDES[name];
  if (override) return { bioguideId: override, method: 'override' };
  const candidates = nameCandidates(name);
  for (const p of identities) {
    const variants = [p.full_name, ...(p.name_variants || [])].flatMap(nameCandidates);
    if (variants.some((v) => candidates.includes(v))) return { bioguideId: p.bioguide_id, method: 'exact' };
  }
  const targetLast = lastName(name);
  if (!targetLast) return null;
  const matches = identities.filter((p) => lastName(p.full_name) === targetLast);
  if (matches.length === 1) return { bioguideId: matches[0].bioguide_id, method: 'unique-last-name' };
  return null;
}

export function linkCongressArchivePoliticians() {
  const identities = listPoliticianIdentities();
  let linked = 0;
  const unmatched = [];
  for (const row of listUnlinkedArchivePoliticianNames()) {
    const match = matchPoliticianName(row.politician, identities);
    if (!match) {
      unmatched.push(row);
      continue;
    }
    linked += linkArchivePoliticianName(row.politician, match.bioguideId);
    addPoliticianNameVariant(match.bioguideId, row.politician);
  }
  if (unmatched.length) {
    log.warn('legislators', `Unmatched archive politician names: ${unmatched.map((r) => r.politician).slice(0, 25).join('; ')}`);
  }
  return { linked, unmatched };
}

export async function refreshLegislatorsAndCommittees() {
  const [legislators, committees, memberships] = await Promise.all([
    fetchYaml('legislators-current', FILES.legislators),
    fetchYaml('committees-current', FILES.committees),
    fetchYaml('committee-membership-current', FILES.memberships),
  ]);

  let politicianCount = 0;
  for (const row of legislators || []) {
    const normalized = normalizePolitician(row);
    if (!normalized.bioguide_id || !normalized.full_name) continue;
    upsertPolitician(normalized);
    politicianCount++;
  }

  const committeeRows = flattenCommittees(committees || []);
  for (const row of committeeRows) upsertCommittee(row);
  const membershipRows = flattenMemberships(memberships);
  replaceCommitteeMemberships(membershipRows);
  const archive = linkCongressArchivePoliticians();
  log.info(
    'legislators',
    `Refreshed ${politicianCount} politicians, ${committeeRows.length} committees, ${membershipRows.length} memberships; linked ${archive.linked} archive trades`
  );
  return {
    politicians: politicianCount,
    committees: committeeRows.length,
    memberships: membershipRows.length,
    linkedArchiveTrades: archive.linked,
    unmatchedArchiveNames: archive.unmatched,
  };
}

export async function ensureLegislatorsAndCommittees() {
  try {
    return await refreshLegislatorsAndCommittees();
  } catch (err) {
    log.warn('legislators', `Legislator/committee refresh failed: ${err.message}`);
    return null;
  }
}
