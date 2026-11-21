import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import request from 'supertest';
import { app } from './helpers.js';
import { buildSiteProfile, demoIdForUrl, normalizeSiteUrl, profileToKnowledgeBase, assertPublicHost } from '../src/services/siteProfile.js';
import { saveDemoProfileRow, db } from '../src/db.js';
import { getVapiDemoAssistant } from '../vapi/assistant.js';

const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf-8');

// A fake site: no network, no DNS.
const PAGES = {
  'https://smilestudio.ae/': fixture('clinic-home.html'),
  'https://smilestudio.ae/services': fixture('clinic-services.html'),
  'https://smilestudio.ae/about-us': '<html><body><p>About us.</p></body></html>',
};
const fakeFetch = async (url) => {
  const html = PAGES[url.toString()];
  return new Response(html ?? 'not found', { status: html ? 200 : 404, headers: { 'content-type': 'text/html' } });
};
const fakeLookup = async () => [{ address: '93.184.216.34', family: 4 }];

describe('website -> demo profile', () => {
  test('extracts name, services with prices, doctors, hours and currency', async () => {
    const p = await buildSiteProfile('smilestudio.ae', { fetchImpl: fakeFetch, lookup: fakeLookup, openai: null });
    assert.equal(p.name, 'Smile Studio Dental');
    assert.equal(p.niche, 'dental clinic');
    assert.equal(p.city, 'Dubai');
    assert.equal(p.country, 'AE');
    assert.equal(p.currency, 'AED');
    assert.equal(p.timezone, 'Asia/Dubai');
    assert.equal(p.phone, '+971 4 555 0100');
    assert.equal(p.hours, 'Monday to Saturday 09:00-21:00');
    assert.deepEqual(p.doctors, ['Dr. Amira Hassan', 'Dr. Omar Said']);
    const whitening = p.services.find((s) => s.name === 'Teeth Whitening');
    assert.match(whitening.price, /AED 1,200/);
    assert.ok(p.services.some((s) => s.name === 'Dental Implants'));
    assert.ok(!p.services.some((s) => s.name === 'Botox'), 'text inside <script> is not content');
    assert.ok(p.faqs.some((f) => /insurance/.test(f)));
    assert.ok(!p.faqs.some((f) => /\bI had\b/.test(f)), 'testimonials are not facts');
  });

  test('knowledge base entries answer the usual questions', async () => {
    const p = await buildSiteProfile('smilestudio.ae', { fetchImpl: fakeFetch, lookup: fakeLookup, openai: null });
    const kb = profileToKnowledgeBase(p);
    assert.ok(kb.find((e) => e.id === 'hours-location').text.includes('Monday to Saturday'));
    assert.ok(kb.find((e) => e.id === 'service-teeth-whitening').text.includes('AED 1,200'));
  });

  test('same site gives the same id whatever the link looks like', () => {
    assert.equal(demoIdForUrl('https://www.smilestudio.ae/contact'), demoIdForUrl('smilestudio.ae'));
    assert.throws(() => normalizeSiteUrl('ftp://smilestudio.ae'));
  });

  test('refuses private and local addresses', async () => {
    for (const host of ['127.0.0.1', '169.254.169.254', '10.0.0.5', 'localhost', '::1']) {
      await assert.rejects(assertPublicHost(host), /not allowed/, host);
    }
    await assert.rejects(assertPublicHost('evil.test', async () => [{ address: '192.168.1.10', family: 4 }]), /not allowed/);
  });
});

describe('demo API', () => {
  test('needs a url, and refuses private addresses without saving anything', async () => {
    assert.equal((await request(app).post('/demo/profiles').send({})).status, 400);
    const res = await request(app).post('/demo/profiles').send({ url: 'http://169.254.169.254/latest' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /not allowed/);
  });

  test('CORS only for the demo page origins', async () => {
    const ok = await request(app).options('/demo/profiles').set('Origin', 'https://upperlayerstudio.com');
    assert.equal(ok.status, 204);
    assert.equal(ok.headers['access-control-allow-origin'], 'https://upperlayerstudio.com');
    const bad = await request(app).options('/demo/profiles').set('Origin', 'https://evil.example');
    assert.equal(bad.status, 403);
    assert.equal(bad.headers['access-control-allow-origin'], undefined);
  });

  test('returns a saved profile with prompt variables, link details winning', async () => {
    const p = await buildSiteProfile('smilestudio.ae', { fetchImpl: fakeFetch, lookup: fakeLookup, openai: null });
    const id = demoIdForUrl('smilestudio.ae');
    saveDemoProfileRow({ id, url: 'https://smilestudio.ae/', profile: p });
    const res = await request(app).get(`/demo/profiles/${id}`).query({ city: 'Abu Dhabi', doctor: 'Doctor' });
    assert.equal(res.status, 200);
    assert.equal(res.body.variables.clinic_name, 'Smile Studio Dental');
    assert.equal(res.body.variables.city, 'Abu Dhabi');
    assert.equal(res.body.variables.doctor, 'Dr. Amira Hassan', 'a placeholder "Doctor" from the sheet is ignored');
    assert.match(res.body.variables.clinic_facts, /Teeth Whitening \(AED 1,200/);
    assert.equal((await request(app).get('/demo/profiles/nope')).status, 404);
  });
});

describe('demo assistant calls', () => {
  const post = (path, message) =>
    request(app).post(path).set('x-functions-secret', process.env.FUNCTIONS_SECRET).send({ message });
  const demoCall = (id, ...calls) => ({
    type: 'tool-calls',
    call: { id, assistantOverrides: { variableValues: { demo_id: demoIdForUrl('smilestudio.ae'), clinic_name: 'Smile Studio Dental' } } },
    toolCallList: calls.map(([name, parameters], i) => ({ id: `tc-${i}`, name, parameters })),
  });
  const results = (res) => res.body.results.map((r) => JSON.parse(r.result));

  test('answer from the clinic\'s own site and book a fake slot', async () => {
    const [kb, avail] = results(
      await post('/webhooks/vapi/demo', demoCall('demo-1', ['search_knowledge_base', { query: 'how much is teeth whitening' }], ['check_availability', { service: 'teeth whitening' }]))
    );
    assert.match(kb.results[0].info, /AED 1,200/);
    assert.equal(avail.available, true);

    const [booked] = results(
      await post('/webhooks/vapi/demo', demoCall('demo-1', ['book_appointment', { service: 'Root canal', start_time: avail.slots[0].start, name: 'Demo Caller', phone: '+971501234567', email: 'demo@example.org' }]))
    );
    assert.equal(booked.success, true, booked.error);

    const row = db.prepare(`SELECT * FROM bookings WHERE call_id = 'demo-1'`).get();
    assert.equal(row.demo_id, demoIdForUrl('smilestudio.ae'));
    assert.match(row.external_booking_id, /^MOCK-/);
  });

  test('a demo booking is invisible to the real phone line', async () => {
    const [found] = results(await post('/webhooks/vapi', demoCall('real-1', ['lookup_appointment', { phone: '+971501234567' }])));
    assert.equal(found.found, false);
  });

  test('a demo call with no profile still runs in demo mode', async () => {
    const msg = { type: 'tool-calls', call: { id: 'demo-2' }, toolCallList: [{ id: 'a', name: 'check_availability', parameters: { service: 'Anything' } }] };
    const [avail] = results(await post('/webhooks/vapi/demo', msg));
    assert.equal(avail.available, true);
  });

  test('demo assistant uses the demo webhook and no transfer', () => {
    const a = getVapiDemoAssistant();
    assert.match(a.server.url, /\/webhooks\/vapi\/demo$/);
    assert.ok(!a.model.tools.some((t) => t.type === 'transferCall'));
    assert.match(a.model.messages[0].content, /\{\{clinic_facts\}\}/);
  });
});

describe('availability answers', () => {
  test('a bare date for the search window is accepted, not bounced back to the agent', async () => {
    const res = await request(app)
      .post('/webhooks/vapi/demo')
      .set('x-functions-secret', process.env.FUNCTIONS_SECRET)
      .send({ message: { type: 'tool-calls', call: { id: 'demo-3' }, toolCallList: [{ id: 'a', name: 'check_availability', parameters: { service: 'Botox', date_from: '2030-01-07', date_to: '2030-01-10' } }] } });
    const result = JSON.parse(res.body.results[0].result);
    assert.equal(result.error, undefined);
    assert.equal(result.available, true);
  });

  test('offers times on different days rather than back-to-back slots', async () => {
    const { pickSpreadSlots } = await import('../src/tools/handlers.js');
    const slots = ['2030-01-07T19:30:00Z', '2030-01-07T20:00:00Z', '2030-01-07T20:30:00Z', '2030-01-08T19:30:00Z', '2030-01-09T19:30:00Z'].map((start) => ({ start }));
    assert.deepEqual(pickSpreadSlots(slots).map((s) => s.start), ['2030-01-07T19:30:00Z', '2030-01-08T19:30:00Z', '2030-01-09T19:30:00Z']);
    assert.equal(pickSpreadSlots(slots.slice(0, 2)).length, 2);
  });
});
