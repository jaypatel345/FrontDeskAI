import { Router } from 'express';
import { upsertCall } from '../db.js';

export const blandWebhookRouter = Router();

// Field names per https://docs.bland.ai/tutorials/post-call-webhooks — the `escalated`
// detection is best-effort (no confirmed dedicated field); cross-check against a real
// payload once verification clears and adjust if `status`/`variables` differ.
blandWebhookRouter.post('/', (req, res) => {
  const call = req.body || {};
  if (!call.call_id) return res.sendStatus(200);

  const transcript = Array.isArray(call.transcripts)
    ? call.transcripts.map((t) => `${t.user || 'agent'}: ${t.text}`).join('\n')
    : null;

  const escalated = /transfer/i.test(call.status || '') ? 1 : 0;

  upsertCall({
    call_id: call.call_id,
    agent_id: null,
    from_number: call.from || null,
    to_number: call.to || null,
    status: call.completed ? 'ended' : call.status || 'in_progress',
    started_at: call.created_at ? new Date(call.created_at).getTime() : Date.now(),
    ended_at: call.completed ? Date.now() : null,
    disconnection_reason: call.status || null,
    transcript,
    recording_url: call.recording_url || null,
    intent: null,
    escalated,
  });

  console.log(`[bland-webhook] update for call ${call.call_id}`);
  res.sendStatus(200);
});
