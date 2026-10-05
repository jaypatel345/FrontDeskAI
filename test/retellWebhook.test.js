import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import request from 'supertest';
import { app } from './helpers.js';
import { isValidRetellSignature } from '../src/routes/retellWebhook.js';

const API_KEY = process.env.RETELL_API_KEY;

// Same format retell-sdk's sign() produces: v=<ms>,d=<hex HMAC-SHA256(key, body + ms)>.
function sign(body, key = API_KEY, timestamp = Date.now()) {
  return `v=${timestamp},d=${crypto.createHmac('sha256', key).update(body + timestamp).digest('hex')}`;
}

const body = JSON.stringify({ event: 'call_ended', call: { call_id: 'webhook-test-call', call_status: 'ended' } });
const post = (signature) => {
  const req = request(app).post('/webhooks/retell').set('Content-Type', 'application/json');
  if (signature) req.set('x-retell-signature', signature);
  return req.send(body);
};

describe('isValidRetellSignature', () => {
  test('accepts a correct signature', () => {
    assert.equal(isValidRetellSignature(body, sign(body), API_KEY), true);
  });

  test('rejects a signature made with another key', () => {
    assert.equal(isValidRetellSignature(body, sign(body, 'other-key'), API_KEY), false);
  });

  test('rejects a tampered body', () => {
    assert.equal(isValidRetellSignature(body.replace('ended', 'error'), sign(body), API_KEY), false);
  });

  test('rejects a signature older than 5 minutes (replay)', () => {
    const old = Date.now() - 6 * 60 * 1000;
    assert.equal(isValidRetellSignature(body, sign(body, API_KEY, old), API_KEY), false);
  });

  test('rejects malformed signatures', () => {
    for (const bad of ['', 'abc', 'v=123', `d=${'a'.repeat(64)}`, `v=1,d=${'z'.repeat(64)}`]) {
      assert.equal(isValidRetellSignature(body, bad, API_KEY), false, bad);
    }
  });
});

describe('POST /webhooks/retell in production', () => {
  test('401 without a signature', async () => {
    assert.equal((await post(null)).status, 401);
  });

  test('401 with a bad signature', async () => {
    assert.equal((await post(sign(body, 'other-key'))).status, 401);
  });

  test('200 with a valid signature', async () => {
    assert.equal((await post(sign(body))).status, 200);
  });
});
