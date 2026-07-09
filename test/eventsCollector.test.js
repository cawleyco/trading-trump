import test from 'node:test'
import assert from 'node:assert/strict'
import {
  billActionEvent,
  generateLobbyingDeadlineEvents,
  normalizeMeetingEvent,
  staticElectionEvents,
} from '../server/sources/eventsCollector.js'

test('normalizeMeetingEvent maps committee meetings to sector events', () => {
  const committees = [{
    committee_id: 'HSAS',
    name: 'Armed Services',
    sectors: ['defense-aerospace', 'technology'],
  }]
  const event = normalizeMeetingEvent({
    title: 'Hearing on defense supply chains',
    eventDate: '2026-08-12T10:00:00Z',
    committeeCode: 'HSAS',
    url: 'https://example.test/hearing',
  }, committees)

  assert.equal(event.eventType, 'hearing')
  assert.equal(event.eventDate, '2026-08-12')
  assert.equal(event.committeeId, 'HSAS')
  assert.deepEqual(event.sectors, ['defense-aerospace', 'technology'])
  assert.ok(event.dedupKey.includes('hearing|2026-08-12|HSAS'))
})

test('billActionEvent preserves action context and sectors', () => {
  const event = billActionEvent({
    bill_id: 'hr1-119',
    title: 'Defense Supply Chain Act',
    latest_action: 'Ordered reported by committee',
    latest_action_date: '2026-07-20',
    committees: ['HSAS'],
    sectors: ['defense-aerospace'],
    source_url: 'https://example.test/bill',
  })

  assert.equal(event.eventType, 'bill-action')
  assert.equal(event.eventDate, '2026-07-20')
  assert.equal(event.committeeId, 'HSAS')
  assert.deepEqual(event.sectors, ['defense-aerospace'])
  assert.ok(event.title.includes('Ordered reported'))
})

test('static event generators stay within the requested window', () => {
  const deadlines = generateLobbyingDeadlineEvents({ from: '2026-07-01', daysAhead: 130 })
  assert.deepEqual(deadlines.map((e) => e.eventDate), ['2026-07-20', '2026-10-20'])
  assert.ok(deadlines.every((e) => e.eventType === 'lobbying-deadline'))

  const elections = staticElectionEvents({ from: '2026-07-01', daysAhead: 200 })
  assert.deepEqual(elections.map((e) => e.eventDate), ['2026-11-03'])
  assert.equal(elections[0].eventType, 'election')
})
