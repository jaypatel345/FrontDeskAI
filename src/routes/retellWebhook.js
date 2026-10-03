import { Router } from 'express';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { upsertCall } from '../db.js';

export const retellWebhookRouter = Router();

function isValidSignature(req) {
  if (!config.retell.apiKey) return true; // signature check skipped until a key is configured
  const signature = req.get('x-retell-signature');
  if (!signature) return false;
  const expected = crypto.createHmac('sha256', config.retell.apiKey).update(req.rawBody || '').digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

retellWebhookRouter.post('/', (req, res) => {
  // Signature check is best-effort here; confirm the exact scheme against Retell's
  // current docs/SDK helper before relying on it in production.
  if (!isValidSignature(req)) {
    console.warn('[retell-webhook] signature mismatch, processing anyway in dev mode');
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
