import { Router } from 'express';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { upsertCall } from '../db.js';

export const retellWebhookRouter = Router();

const SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;

// Retell signs each webhook as "v=<timestamp ms>,d=<hex HMAC-SHA256(apiKey, rawBody + timestamp)>"
// (same scheme as Retell.verify in retell-sdk's lib/webhook_auth). The timestamp window stops an
// old captured request being replayed later.
export function isValidRetellSignature(rawBody, signature, apiKey, now = Date.now()) {
  const match = /^v=(\d+),d=([0-9a-f]{64})$/i.exec(signature || '');
  if (!match) return false;
  const timestamp = Number(match[1]);
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > SIGNATURE_MAX_AGE_MS) return false;

  const expected = crypto.createHmac('sha256', apiKey).update(`${rawBody}${timestamp}`).digest();
  const given = Buffer.from(match[2], 'hex');
  return crypto.timingSafeEqual(expected, given);
}

retellWebhookRouter.post('/', (req, res) => {
  // Anyone who knows this URL could otherwise write fake calls into the dashboard. In production
  // an unverifiable request is rejected; in dev it's logged and processed so local testing with
  // hand-written payloads still works.
  const verified =
    Boolean(config.retell.apiKey) &&
    isValidRetellSignature(req.rawBody?.toString('utf-8') ?? '', req.get('x-retell-signature'), config.retell.apiKey);
  if (!verified) {
    if (config.isProduction) {
      console.warn('[retell-webhook] rejected request with missing or invalid signature');
      return res.sendStatus(401);
    }
    console.warn('[retell-webhook] signature missing or invalid - processing anyway (dev only)');
  }

  const { event, call } = req.body || {};
  if (!call?.call_id) return res.sendStatus(200);

  const escalated = call.disconnection_reason === 'call_transfer' || call.transfer_number ? 1 : 0;

  // call_analyzed carries a real per-call latency breakdown (e2e turn-taking time, ms) -
  // sum/num gives the average response latency for that call, the metric the spec asks for.
  const e2e = call.latency?.e2e;
  const avgLatencyMs = e2e?.num ? Math.round(e2e.sum / e2e.num) : null;

  upsertCall({
    call_id: call.call_id,
    agent_id: call.agent_id || null,
    from_number: call.from_number || null,
    to_number: call.to_number || null,
    status: call.call_status || event,
    started_at: call.start_timestamp || Date.now(),
    ended_at: call.end_timestamp || null,
    disconnection_reason: call.disconnection_reason || null,
    transcript: call.transcript || null,
    recording_url: call.recording_url || null,
    intent: null,
    escalated,
    avg_response_latency_ms: avgLatencyMs,
  });

  console.log(`[retell-webhook] ${event} for call ${call.call_id}`);
  res.sendStatus(200);
});
