import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { app } from './helpers.js';
import { config } from '../src/config.js';
import { getVapiDemoHindiAssistant } from '../vapi/assistant.js';
import { setSarvamRequest } from '../src/routes/voice.js';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

const SECRET = process.env.FUNCTIONS_SECRET;
const voiceRequest = (text = 'नमस्ते, आपका appointment book हो गया है।', sampleRate = 24000) => ({
  message: { type: 'voice-request', text, sampleRate },
});
const post = (body, query = '') => {
  const req = request(app).post(`/voice/sarvam${query}`).set('Content-Type', 'application/json');
  if (SECRET) req.set('x-functions-secret', SECRET);
  return req.buffer(true).parse((res, cb) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  }).send(body);
};

describe('Sarvam custom voice', () => {
  const realKey = config.sarvam.apiKey;
  let sent;
  // A fake https.request: records what we sent, answers with a status and body chunks.
  const fakeSarvam = (status = 200, chunks = [Buffer.from([1, 2, 3, 4]), Buffer.from([5, 6])]) =>
    setSarvamRequest((options, onResponse) => {
      const req = new EventEmitter();
      req.destroy = () => {};
      req.end = (body) => {
        sent = { options, body: JSON.parse(body) };
        const res = Readable.from(chunks);
        res.statusCode = status;
        setImmediate(() => onResponse(res));
      };
      return req;
    });
  beforeEach(() => {
    config.sarvam.apiKey = 'test-key';
    sent = null;
    fakeSarvam();
  });
  afterEach(() => {
    setSarvamRequest(null);
    config.sarvam.apiKey = realKey;
  });

  test('streams raw PCM from Sarvam at the rate Vapi asks for, in Ritu\'s voice', async () => {
    const res = await post(voiceRequest('नमस्ते', 16000));
    assert.equal(res.status, 200);
    assert.deepEqual([...res.body], [1, 2, 3, 4, 5, 6]);
    assert.equal(sent.options.host, 'api.sarvam.ai');
    assert.equal(sent.options.path, '/text-to-speech/stream');
    assert.equal(sent.options.headers['api-subscription-key'], 'test-key');
    assert.equal(sent.body.pace, 1.1);
    assert.equal(sent.body.output_audio_codec, 'linear16');
    assert.equal(sent.body.speech_sample_rate, 16000);
    assert.equal(sent.body.speaker, 'ritu_hi_customer');
    assert.equal(sent.body.language_code, 'hi-IN');
    assert.equal(sent.body.text, 'नमस्ते');
  });

  test('speaker and language can be chosen in the URL', async () => {
    await post(voiceRequest(), '?speaker=simran_hi_conversation&lang=gu-IN');
    assert.equal(sent.body.speaker, 'simran_hi_conversation');
    assert.equal(sent.body.language_code, 'gu-IN');
  });

  test('rejects bad requests without calling Sarvam', async () => {
    assert.equal((await post({ message: { type: 'voice-request', text: '  ', sampleRate: 24000 } })).status, 400);
    assert.equal((await post(voiceRequest('hi', 44100))).status, 400);
    assert.equal((await post({ message: { type: 'status-update' } })).status, 400);
    assert.equal(sent, null);
  });

  test('a Sarvam error returns 502 so Vapi uses the fallback voice', async () => {
    fakeSarvam(422, [Buffer.from('{"error":"bad"}')]);
    assert.equal((await post(voiceRequest())).status, 502);
  });

  test('needs the server secret', { skip: !SECRET }, async () => {
    const res = await request(app).post('/voice/sarvam').send(voiceRequest());
    assert.equal(res.status, 401);
  });

  test('Hindi demo assistant uses the Sarvam voice with an Azure fallback and Hinglish', () => {
    const a = getVapiDemoHindiAssistant();
    assert.equal(a.voice.provider, 'custom-voice');
    assert.match(a.voice.server.url, /\/voice\/sarvam$/);
    assert.equal(a.voice.fallbackPlan.voices[0].voiceId, 'hi-IN-SwaraNeural');
    assert.equal(a.transcriber.language, 'multi');
    assert.match(a.model.messages[0].content, /^\s*You are Maya/);
    assert.match(a.model.messages[0].content, /Hinglish/);
    assert.match(a.server.url, /\/webhooks\/vapi\/demo$/);
  });

  test('Hindi demo: phone numbers in English words, short casual replies, Hindi tool lines', () => {
    const a = getVapiDemoHindiAssistant();
    const prompt = a.model.messages[0].content;
    assert.match(prompt, /Phone numbers: ALWAYS in English words/);
    assert.match(prompt, /ये सब services हमारे पास हैं/);
    const check = a.model.tools.find((t) => t.function?.name === 'check_availability');
    assert.equal(check.messages[0].content, 'एक second, calendar देख लेती हूँ।');
    for (const t of a.model.tools) for (const m of t.messages || []) assert.doesNotMatch(m.content, /Let me|Sure thing/);
  });
});
