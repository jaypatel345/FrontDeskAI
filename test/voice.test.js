import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { app } from './helpers.js';
import { config } from '../src/config.js';
import { getVapiDemoHindiAssistant } from '../vapi/assistant.js';

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
  const realFetch = globalThis.fetch;
  const realKey = config.sarvam.apiKey;
  let sent;
  beforeEach(() => {
    config.sarvam.apiKey = 'test-key';
    sent = null;
    globalThis.fetch = async (url, init) => {
      sent = { url, body: JSON.parse(init.body), key: init.headers['api-subscription-key'] };
      // Two chunks of fake 16-bit PCM, as Sarvam streams it.
      return new Response(new ReadableStream({
        start(c) { c.enqueue(new Uint8Array([1, 2, 3, 4])); c.enqueue(new Uint8Array([5, 6])); c.close(); },
      }), { status: 200, headers: { 'content-type': 'audio/pcm' } });
    };
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    config.sarvam.apiKey = realKey;
  });

  test('streams raw PCM from Sarvam at the rate Vapi asks for, in Ritu\'s voice', async () => {
    const res = await post(voiceRequest('नमस्ते', 16000));
    assert.equal(res.status, 200);
    assert.deepEqual([...res.body], [1, 2, 3, 4, 5, 6]);
    assert.equal(sent.url, 'https://api.sarvam.ai/text-to-speech/stream');
    assert.equal(sent.key, 'test-key');
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
    globalThis.fetch = async () => new Response('{"error":"bad"}', { status: 422 });
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
});
