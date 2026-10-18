import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { app, futureIso } from './helpers.js';
import { getIndustry, listIndustries, listIndustryIds, normalizeIndustryKey } from '../src/industries/registry.js';
import { searchKnowledgeBase } from '../src/services/rag.js';
import { getVapiAssistant } from '../vapi/assistant.js';
import { getRetellPayload } from '../retell/prompt.js';
import { buildSchemas, validateArgs } from '../src/validation/toolArgs.js';
import { runTool } from '../src/tools/handlers.js';

describe('Industry Presets Registry', () => {
  test('lists the 3 supported industries', () => {
    const ids = listIndustryIds();
    assert.deepEqual(ids.sort(), ['clinic', 'general-business', 'real-estate'].sort());
    const list = listIndustries();
    assert.equal(list.length, 3);
  });

  test('normalizes aliases accurately', () => {
    assert.equal(normalizeIndustryKey('medical'), 'clinic');
    assert.equal(normalizeIndustryKey('aesthetics'), 'clinic');
    assert.equal(normalizeIndustryKey('realty'), 'real-estate');
    assert.equal(normalizeIndustryKey('realestate'), 'real-estate');
    assert.equal(normalizeIndustryKey('corporate'), 'general-business');
    assert.equal(normalizeIndustryKey('business'), 'general-business');
  });

  test('resolves preset by string key or alias', () => {
    const clinic = getIndustry('clinic');
    assert.equal(clinic.id, 'clinic');
    assert.equal(clinic.personaName, 'Ava');

    const realEstate = getIndustry('real-estate');
    assert.equal(realEstate.id, 'real-estate');
    assert.equal(realEstate.personaName, 'Marcus');

    const general = getIndustry('general-business');
    assert.equal(general.id, 'general-business');
    assert.equal(general.personaName, 'Jordan');
  });

  test('resolves preset from request/call context', () => {
    assert.equal(getIndustry({ query: { industry: 'real-estate' } }).id, 'real-estate');
    assert.equal(getIndustry({ params: { industry: 'general-business' } }).id, 'general-business');
    assert.equal(getIndustry({ headers: { 'x-industry': 'clinic' } }).id, 'clinic');
    assert.equal(getIndustry(null).id, 'clinic'); // default fallback
  });
});

describe('Multi-Industry Knowledge Bases', () => {
  test('clinic KB returns Botox and recovery info', async () => {
    const results = await searchKnowledgeBase('Botox recovery time', 3, 'clinic');
    assert.ok(results.length > 0);
    assert.ok(results.some((r) => r.text.toLowerCase().includes('botox')));
  });

  test('real-estate KB returns listings and tour info', async () => {
    const results = await searchKnowledgeBase('Evergreen Terrace listing price', 3, 'real-estate');
    assert.ok(results.length > 0);
    assert.ok(results.some((r) => r.text.includes('Evergreen Terrace') && r.text.includes('$650,000')));
  });

  test('general-business KB returns consulting services and office hours', async () => {
    const results = await searchKnowledgeBase('consulting services discovery call', 3, 'general-business');
    assert.ok(results.length > 0);
    assert.ok(results.some((r) => r.text.toLowerCase().includes('vanguard') || r.text.toLowerCase().includes('discovery')));
  });
});

describe('Multi-Industry Service Validation', () => {
  test('clinic schema validates clinic treatments', () => {
    const clinicSchemas = buildSchemas('clinic');
    const valid = validateArgs(clinicSchemas.bookAppointment, {
      service: 'lip filler',
      start_time: futureIso(5),
      name: 'Alice',
      phone: '5552010001',
      email: 'alice@example.com',
    });
    assert.ok(valid.data);
    assert.equal(valid.data.service, 'Filler');

    const invalid = validateArgs(clinicSchemas.bookAppointment, {
      service: 'Property Tour',
      start_time: futureIso(5),
      name: 'Alice',
      phone: '5552010001',
      email: 'alice@example.com',
    });
    assert.ok(invalid.error);
    assert.match(invalid.error, /isn't a service the clinic offers/);
  });

  test('real-estate schema validates property tours and consultations', () => {
    const reSchemas = buildSchemas('real-estate');
    const valid = validateArgs(reSchemas.bookAppointment, {
      service: 'showing walkthrough',
      start_time: futureIso(5),
      name: 'Bob',
      phone: '5552010002',
      email: 'bob@example.com',
    });
    assert.ok(valid.data);
    assert.equal(valid.data.service, 'Property Tour');

    const invalid = validateArgs(reSchemas.bookAppointment, {
      service: 'Botox',
      start_time: futureIso(5),
      name: 'Bob',
      phone: '5552010002',
      email: 'bob@example.com',
    });
    assert.ok(invalid.error);
    assert.match(invalid.error, /isn't an offered service/);
  });

  test('general-business schema validates discovery calls and demos', () => {
    const bizSchemas = buildSchemas('general-business');
    const valid = validateArgs(bizSchemas.bookAppointment, {
      service: 'introductory discovery call',
      start_time: futureIso(5),
      name: 'Charlie',
      phone: '5552010003',
      email: 'charlie@enterprise.com',
    });
    assert.ok(valid.data);
    assert.equal(valid.data.service, 'Discovery Call');

    const invalid = validateArgs(bizSchemas.bookAppointment, {
      service: 'Chemical Peel',
      start_time: futureIso(5),
      name: 'Charlie',
      phone: '5552010003',
      email: 'charlie@enterprise.com',
    });
    assert.ok(invalid.error);
    assert.match(invalid.error, /isn't an offered service/);
  });
});

describe('Multi-Industry Tool Execution via HTTP', () => {
  const secret = process.env.FUNCTIONS_SECRET;

  test('POST /functions/real-estate/book-appointment books a property showing', async () => {
    const time = futureIso(10);
    const res = await request(app)
      .post('/functions/real-estate/book-appointment')
      .set('x-functions-secret', secret)
      .send({
        service: 'Property Tour',
        start_time: time,
        name: 'Sarah Buyer',
        phone: '5553010001',
        email: 'sarah@example.com',
      });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.match(res.body.message, /^Booked Property Tour/);
  });

  test('POST /functions/general-business/book-appointment books a corporate discovery call', async () => {
    const time = futureIso(11);
    const res = await request(app)
      .post('/functions/general-business/book-appointment')
      .set('x-functions-secret', secret)
      .send({
        service: 'Discovery Call',
        start_time: time,
        name: 'David Executive',
        phone: '5553010002',
        email: 'david@corp.com',
      });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.match(res.body.message, /^Booked Discovery Call/);
  });

  test('POST /functions/real-estate/search-knowledge-base finds listing info', async () => {
    const res = await request(app)
      .post('/functions/real-estate/search-knowledge-base')
      .set('x-functions-secret', secret)
      .send({ query: 'Grand Avenue loft' });

    assert.equal(res.status, 200);
    assert.ok(res.body.results.length > 0);
    assert.ok(res.body.results.some((r) => r.info.includes('Grand Avenue')));
  });

  test('POST /functions/general-business/search-knowledge-base finds company info', async () => {
    const res = await request(app)
      .post('/functions/general-business/search-knowledge-base')
      .set('x-functions-secret', secret)
      .send({ query: 'corporate office hours' });

    assert.equal(res.status, 200);
    assert.ok(res.body.results.length > 0);
    assert.ok(res.body.results.some((r) => r.info.includes('Vanguard')));
  });
});

describe('Voice Platform Multi-Industry Payloads', () => {
  test('generates valid Vapi assistant payloads for all 3 industries', () => {
    const clinicAst = getVapiAssistant('clinic');
    assert.match(clinicAst.firstMessage, /Ava/);
    assert.match(clinicAst.model.messages[0].content, /cosmetic clinic/);

    const reAst = getVapiAssistant('real-estate');
    assert.match(reAst.firstMessage, /Apex Realty Group/);
    assert.match(reAst.model.messages[0].content, /Marcus/);
    assert.match(reAst.server.url, /\/webhooks\/vapi\/real-estate/);

    const bizAst = getVapiAssistant('general-business');
    assert.match(bizAst.firstMessage, /Vanguard Enterprise Solutions/);
    assert.match(bizAst.model.messages[0].content, /Jordan/);
    assert.match(bizAst.server.url, /\/webhooks\/vapi\/general-business/);
  });

  test('generates valid Retell payloads for all 3 industries', () => {
    const clinicRetell = getRetellPayload('clinic');
    assert.equal(clinicRetell.industryId, 'clinic');
    assert.match(clinicRetell.llmPayload.begin_message, /Ava/);

    const reRetell = getRetellPayload('real-estate');
    assert.equal(reRetell.industryId, 'real-estate');
    assert.match(reRetell.llmPayload.begin_message, /Apex Realty Group/);

    const bizRetell = getRetellPayload('general-business');
    assert.equal(bizRetell.industryId, 'general-business');
    assert.match(bizRetell.llmPayload.begin_message, /Vanguard Enterprise Solutions/);
  });
});
