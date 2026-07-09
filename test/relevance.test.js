import test from 'node:test'
import assert from 'node:assert/strict'
import {
  committeeOverseesAgency,
  sectorsForCommittee,
  sectorsForLobbyingIssues,
  sectorsForPolicyArea,
} from '../server/lib/committeeSectors.js'
import { matchPoliticianName, normalizeCommittee, normalizePolitician } from '../server/sources/legislators.js'
import { computeRelevance } from '../server/intel/relevance.js'

test('committee and policy maps return stable sector buckets', () => {
  assert.deepEqual(sectorsForCommittee({ name: 'House Armed Services Committee' }), ['defense-aerospace', 'technology'])
  assert.ok(sectorsForCommittee({ name: 'Energy and Commerce' }).includes('healthcare'))
  assert.ok(sectorsForPolicyArea('Science, Technology, Communications').includes('technology'))
  assert.ok(sectorsForLobbyingIssues(['DEF', 'HCR']).includes('healthcare'))
  assert.equal(committeeOverseesAgency({ name: 'Armed Services' }, 'Department of Defense'), true)
})

test('legislator normalizers and archive name matching handle common formats', () => {
  const politician = normalizePolitician({
    id: { bioguide: 'D000001' },
    name: { first: 'Jane', last: 'Doe', official_full: 'Jane Q. Doe' },
    terms: [{ type: 'rep', party: 'Democrat', state: 'CA' }],
  })
  assert.equal(politician.bioguide_id, 'D000001')
  assert.equal(politician.chamber, 'house')
  assert.ok(politician.name_variants.includes('Doe, Jane'))

  const committee = normalizeCommittee({ thomas_id: 'HSAS', name: 'Armed Services', type: 'house' })
  assert.equal(committee.committee_id, 'HSAS')
  assert.ok(committee.sectors.includes('defense-aerospace'))

  const match = matchPoliticianName('Hon. Doe, Jane', [politician])
  assert.deepEqual(match, { bioguideId: 'D000001', method: 'exact' })
})

test('computeRelevance stacks committee, bill, lobbying, and contract signals', async () => {
  const trade = {
    trade_key: 'Jane Doe|LMT|2026-07-01|buy|$50,001 - $100,000',
    politician: 'Jane Doe',
    politician_id: 'D000001',
    ticker: 'LMT',
    disclosure_date: '2026-07-15',
  }
  const committees = [
    { committee_id: 'HSAS', name: 'Armed Services', role: 'chair', sectors: ['defense-aerospace'] },
  ]
  const relevance = await computeRelevance(trade, {
    tickerSector: 'defense-aerospace',
    committees,
    bills: [{
      bill_id: 'hr1-119',
      title: 'Defense Supply Chain Act',
      committees: ['HSAS'],
      sectors: ['defense-aerospace'],
      latest_action_date: '2026-07-01',
      source_url: 'https://example.test/bill',
    }],
    lobbyingFilings: [{
      filing_id: 'filing-1',
      client_name: 'Lockheed Martin',
      filed_at: '2026-06-01',
      issues: ['DEF'],
    }],
    contracts: [{
      contract_id: 'award-1',
      awarding_agency: 'Department of Defense',
      action_date: '2026-06-15',
    }],
  })

  assert.equal(relevance.score, 100)
  assert.deepEqual(
    relevance.signals.map((s) => s.type),
    ['committee-sector', 'committee-leadership', 'active-bill-overlap', 'recent-lobbying', 'lobbying-committee-issue', 'recent-contract']
  )
})
