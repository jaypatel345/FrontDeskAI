import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { app, callTool, futureIso } from './helpers.js';
import { searchWindowEnd } from '../src/routes/functions.js';
import { maskPhone } from '../src/routes/dashboard.js';
import { config } from '../src/config.js';

const DAY_MS = 24 * 3600 * 1000;

describe('book → lookup → reschedule → cancel round trip (mock mode)', () => {
  const phone = '(555) 201-0001';
  const first = futureIso(7);
  const moved = futureIso(8);

  test('check_availability returns slots with a spoken label', async () => {
    const res = await callTool('check-availability', { service: 'botox', date_from: futureIso(7, 0) });
    assert.equal(res.status, 200);
    assert.equal(res.body.available, true);
    assert.ok(res.body.slots.length > 0);
    assert.ok(res.body.slots[0].start && res.body.slots[0].label);
  });

  test('book_appointment books and normalises the service name', async () => {
    const res = await callTool('book-appointment', { service: 'lip filler', start_time: first, name: 'Test Caller', phone, email: 'test@example.org' });
    assert.equal(res.body.success, true, res.body.error);
    assert.match(res.body.message, /^Booked Filler/);
  });

  test('lookup_appointment finds it under a differently formatted number', async () => {
    const res = await callTool('lookup-appointment', { phone: '+1 555 201 0001' });
    assert.equal(res.body.found, true);
    assert.equal(res.body.service, 'Filler');
  });

  test('reschedule_appointment moves it', async () => {
    const res = await callTool('reschedule-appointment', { phone, new_start_time: moved });
    assert.equal(res.body.success, true, res.body.error);
    assert.match(res.body.message, /^Moved your Filler appointment/);
  });

  test('cancel_appointment cancels it, and nothing is left to find', async () => {
    const res = await callTool('cancel-appointment', { phone });
    assert.equal(res.body.success, true, res.body.error);
    assert.equal((await callTool('lookup-appointment', { phone })).body.found, false);
    assert.equal((await callTool('cancel-appointment', { phone })).body.success, false);
  });
});

describe('tool argument validation', () => {
  const valid = { service: 'Botox', start_time: futureIso(9), name: 'Test Caller', phone: '5552010002', email: 'test@example.org' };

  // Each case: [what's wrong, args override, text the agent should get back]
  const cases = [
    ['missing email', { email: undefined }, /email is required - ask the caller/],
    ['bad email', { email: 'jane at gmail' }, /email doesn't look like a valid email/],
    ['short phone', { phone: '555-1234' }, /phone doesn't look like a full phone number/],
    ['unknown service', { service: 'tattoo removal' }, /isn't a service the clinic offers/],
    ['non-ISO date', { start_time: 'next tuesday at 2' }, /start_time must be an ISO 8601 date-time/],
    ['past date', { start_time: '2020-01-01T10:00:00Z' }, /start_time is in the past/],
    ['free-text date gets one error, not two', { start_time: 'tomorrow' }, /^start_time must be an ISO 8601 date-time[^;]*\.$/],
  ];
  for (const [label, override, expected] of cases) {
    test(`book_appointment rejects ${label} with a readable error`, async () => {
      const res = await callTool('book-appointment', { ...valid, ...override });
      assert.equal(res.status, 200); // 200 so Retell reads the error to the agent instead of treating it as a crash
      assert.equal(res.body.success, false);
      assert.match(res.body.error, expected);
    });
  }

  test('check_availability rejects a malformed date', async () => {
    const res = await callTool('check-availability', { service: 'Botox', date_from: '12/10/2026' });
    assert.equal(res.body.available, false);
    assert.match(res.body.error, /date_from must be an ISO 8601/);
  });

  test('capture_lead accepts empty strings for fields the LLM left blank', async () => {
    const res = await callTool('capture-lead', { name: 'Test Caller', phone: '', email: '', treatment_interest: 'Botox' });
    assert.equal(res.body.success, true, res.body.error);
  });

  test('search_knowledge_base requires a query', async () => {
    const res = await callTool('search-knowledge-base', {});
    assert.deepEqual(res.body.results, []);
    assert.match(res.body.error, /query is required/);
  });
});

describe('check_availability lookahead window', () => {
  const from = '2026-10-05T09:00:00-07:00';

  test('widens a narrow LLM window to 21 days', () => {
    const end = searchWindowEnd(from, '2026-10-06T09:00:00-07:00');
    assert.equal(Date.parse(end) - Date.parse(from), 21 * DAY_MS);
  });

  test('uses 21 days when no end date is given', () => {
    assert.equal(Date.parse(searchWindowEnd(from, undefined)) - Date.parse(from), 21 * DAY_MS);
  });

  test('keeps a wider LLM window as-is', () => {
    assert.equal(searchWindowEnd(from, '2026-12-01T00:00:00-08:00'), '2026-12-01T00:00:00-08:00');
  });

  // The 21-day minimum here is 2026-10-26T16:00:00.000Z. Both cases below sort the wrong way as text.
  test('keeps a later end written in another time zone', () => {
    const later = '2026-10-26T15:00:00-05:00'; // 20:00Z, 4h past the minimum
    assert.equal(searchWindowEnd(from, later), later);
  });

  test('widens an earlier end written in another time zone', () => {
    const earlier = '2026-10-26T17:00:00+05:00'; // 12:00Z, 4h short of the minimum
    assert.equal(searchWindowEnd(from, earlier), '2026-10-26T16:00:00.000Z');
  });
});

describe('knowledge base keyword fallback', () => {
  const ask = async (query) => (await callTool('search-knowledge-base', { query })).body.results.map((r) => r.topic);

  test('price question finds the Botox entry first', async () => {
    assert.equal((await ask('how much is botox'))[0], 'service-botox');
  });

  test('opening hours question finds hours/location', async () => {
    assert.ok((await ask('what are your opening hours on saturday')).includes('hours-location'));
  });

  test('returns at most 3 results', async () => {
    assert.ok((await ask('botox filler laser peel price')).length <= 3);
  });
});

describe('dashboard data', () => {
  test('maskPhone keeps only the last 4 digits', () => {
    assert.equal(maskPhone('+15552014821'), '+1 ••• ••• 4821');
    assert.equal(maskPhone('5552014821'), '••• ••• 4821');
    assert.equal(maskPhone(null), null);
  });

  test('/api/dashboard/calls masks numbers and leaves out transcripts', async () => {
    await callTool('capture-lead', { name: 'Masked Caller', phone: '+15552019999' }, { callId: 'mask-test-call' });
    const auth = `Basic ${Buffer.from(`admin:${config.dashboard.password}`).toString('base64')}`;
    const calls = (await request(app).get('/api/dashboard/calls').set('Authorization', auth)).body;
    const call = calls.find((c) => c.call_id === 'mask-test-call');
    assert.equal(call.from_number, '+1 ••• ••• 9999');
    assert.equal(call.transcript, undefined);
    assert.equal(call.recording_url, undefined);
  });
});

describe('mock availability', () => {
  test('slots are in the future, on weekdays, at clinic opening hours', async () => {
    const { slots } = (await callTool('check-availability', { service: 'Botox' })).body;
    assert.ok(slots.length > 0);
    for (const slot of slots) {
      assert.ok(Date.parse(slot.start) > Date.now(), slot.start);
      assert.match(slot.label, /^(9:00 AM|11:00 AM|2:00 PM|4:00 PM)$/);
      const weekday = new Date(slot.start).toLocaleDateString('en-US', { weekday: 'short', timeZone: config.clinicTimezone });
      assert.ok(!['Sat', 'Sun'].includes(weekday), weekday);
    }
  });

  test('a slot offered by check_availability can be booked as-is', async () => {
    const { slots } = (await callTool('check-availability', { service: 'Botox', date_from: futureIso(10, 0) })).body;
    const res = await callTool('book-appointment', { service: 'Botox', start_time: slots[0].start, name: 'Slot Taker', phone: '5552010003', email: 'test@example.org' });
    assert.equal(res.body.success, true, res.body.error);
  });
});
