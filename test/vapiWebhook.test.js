import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { app, futureIso } from './helpers.js';
import { normaliseEndedReason } from '../src/routes/vapiWebhook.js';
import { recentCalls } from '../src/db.js';
import { buildCallProperties } from '../src/services/crm.js';
import { assistant } from '../vapi/assistant.js';

const post = (message, secret = process.env.FUNCTIONS_SECRET) => {
  const req = request(app).post('/webhooks/vapi').set('Content-Type', 'application/json');
  if (secret) req.set('x-functions-secret', secret);
  return req.send({ message });
};

// Shape from https://docs.vapi.ai/server-url/events
const toolCalls = (callId, ...calls) => ({
  type: 'tool-calls',
  call: { id: callId },
  toolCallList: calls.map(([name, parameters], i) => ({ id: `tc-${i}`, name, parameters })),
});

const findCall = (id) => recentCalls(100).find((c) => c.call_id === id);

describe('Vapi webhook auth', () => {
  test('rejects requests without the shared secret', async () => {
    assert.equal((await post(toolCalls('c', ['search_knowledge_base', { query: 'botox' }]), null)).status, 401);
  });

  test('rejects a wrong secret', async () => {
    assert.equal((await post(toolCalls('c', ['search_knowledge_base', { query: 'botox' }]), 'wrong')).status, 401);
  });
});

describe('Vapi tool calls', () => {
  test('answers each tool call with its toolCallId and a string result', async () => {
    const res = await post(toolCalls('vapi-call-1', ['search_knowledge_base', { query: 'how much is botox' }], ['check_availability', { service: 'Botox' }]));
    assert.equal(res.status, 200);
    assert.equal(res.body.results.length, 2);

    const [kb, avail] = res.body.results;
    assert.equal(kb.toolCallId, 'tc-0');
    assert.equal(typeof kb.result, 'string');
    assert.equal(JSON.parse(kb.result).results[0].topic, 'service-botox');
    assert.equal(avail.toolCallId, 'tc-1');
    assert.equal(JSON.parse(avail.result).available, true);
  });

  test('books an appointment and ties it to the Vapi call id', async () => {
    const res = await post(
      toolCalls('vapi-call-2', ['book_appointment', { service: 'Botox', start_time: futureIso(12), name: 'Vapi Caller', phone: '5552010042', email: 'test@example.org' }])
    );
    const result = JSON.parse(res.body.results[0].result);
    assert.equal(result.success, true, result.error);
  });

  test('passes validation errors back for the agent to read', async () => {
    const res = await post(toolCalls('vapi-call-3', ['book_appointment', { service: 'Botox', phone: '123' }]));
    const result = JSON.parse(res.body.results[0].result);
    assert.equal(result.success, false);
    assert.match(result.error, /phone doesn't look like a full phone number/);
  });

  test('accepts OpenAI-style function.arguments as a JSON string', async () => {
    const message = {
      type: 'tool-calls',
      call: { id: 'vapi-call-4' },
      toolCallList: [{ id: 'tc-x', function: { name: 'search_knowledge_base', arguments: '{"query":"are you open on saturday"}' } }],
    };
    const result = JSON.parse((await post(message)).body.results[0].result);
    assert.ok(result.results.some((r) => r.topic === 'hours-location'));
  });

  test('an unknown tool gets an error result, not an HTTP failure', async () => {
    const res = await post(toolCalls('vapi-call-5', ['delete_everything', {}]));
    assert.equal(res.status, 200);
    assert.match(JSON.parse(res.body.results[0].result).error, /Unknown tool/);
  });
});

describe('Vapi call events', () => {
  test('end-of-call-report stores transcript, outcome and latency', async () => {
    await post({ type: 'status-update', status: 'in-progress', call: { id: 'vapi-call-6', startedAt: new Date().toISOString(), customer: { number: '+15552010066' } } });
    await post({
      type: 'end-of-call-report',
      endedReason: 'customer-ended-call',
      call: { id: 'vapi-call-6', endedAt: new Date().toISOString() },
      artifact: { transcript: 'AI: Hi. User: Bye.', recordingUrl: 'https://example.org/rec.wav', performanceMetrics: { turnLatencyAverage: 812.4 } },
    });
    const call = findCall('vapi-call-6');
    assert.equal(call.status, 'ended');
    assert.equal(call.disconnection_reason, 'user_hangup');
    assert.equal(call.transcript, 'AI: Hi. User: Bye.');
    assert.equal(call.avg_response_latency_ms, 812);
    assert.equal(call.from_number, '+15552010066', 'a later event without the number must not erase it');
  });

  test('a forwarded call counts as escalated', async () => {
    await post({ type: 'end-of-call-report', endedReason: 'assistant-forwarded-call', call: { id: 'vapi-call-7' }, artifact: {} });
    assert.equal(findCall('vapi-call-7').escalated, 1);
  });

  test('unsubscribed event types are acknowledged', async () => {
    assert.equal((await post({ type: 'speech-update', call: { id: 'x' } })).status, 200);
  });

  test('normaliseEndedReason maps onto the dashboard vocabulary', () => {
    assert.equal(normaliseEndedReason('customer-ended-call'), 'user_hangup');
    assert.equal(normaliseEndedReason('assistant-forwarded-call'), 'call_transfer');
    assert.equal(normaliseEndedReason('customer-did-not-answer'), 'dial_no_answer');
    assert.equal(normaliseEndedReason('voicemail'), 'voicemail_reached');
    assert.equal(normaliseEndedReason(null), null);
  });
});

describe('HubSpot call log', () => {
  test('builds a timeline entry with duration, numbers and an escaped transcript', () => {
    const props = buildCallProperties({
      callId: 'vapi-call-8',
      fromNumber: '+15552010088',
      startedAt: Date.parse('2026-10-05T12:00:00Z'),
      endedAt: Date.parse('2026-10-05T12:02:30Z'),
      outcome: 'customer-ended-call',
      summary: 'Caller booked Botox.',
      transcript: 'AI: Hi <there>\nUser: Book Botox',
    });
    assert.equal(props.hs_timestamp, '2026-10-05T12:00:00.000Z');
    assert.equal(props.hs_call_duration, '150000');
    assert.equal(props.hs_call_from_number, '+15552010088');
    assert.equal(props.hs_call_title, 'AI receptionist call - customer-ended-call');
    assert.match(props.hs_call_body, /Caller booked Botox\./);
    assert.match(props.hs_call_body, /Hi &lt;there&gt;<br>User: Book Botox/);
  });

  test('a web call with no number or timing still builds', () => {
    const props = buildCallProperties({ callId: 'web-1', endedAt: Date.now() });
    assert.equal(props.hs_call_from_number, undefined);
    assert.equal(props.hs_call_duration, undefined);
  });
});

describe('Vapi assistant config', () => {
  const fnTools = assistant.model.tools.filter((t) => t.type === 'function');

  test('every function tool sends the shared secret to the webhook', () => {
    for (const t of fnTools) {
      assert.match(t.server.url, /\/webhooks\/vapi$/);
      assert.equal(t.server.headers['x-functions-secret'], process.env.FUNCTIONS_SECRET);
    }
    assert.equal(assistant.server.headers['x-functions-secret'], process.env.FUNCTIONS_SECRET);
  });

  test('every function tool has a handler on the server', async () => {
    const { tools } = await import('../src/tools/handlers.js');
    for (const t of fnTools) assert.ok(tools[t.function.name], t.function.name);
  });

  test('prompt grounds "today" in the clinic timezone', () => {
    assert.match(assistant.model.messages[0].content, /\{\{"now" \| date: .*America\/Los_Angeles"\}\}/);
  });
});
