import { Router } from 'express';
import { runTool } from '../tools/handlers.js';
import { upsertCall } from '../db.js';
import { logCallToCrm } from '../services/crm.js';

// Vapi sends everything to one server URL as { message: { type, call, ... } } - tool calls and
// call lifecycle events alike (https://docs.vapi.ai/server-url/events). Auth is the same
// x-functions-secret header as /functions/*, set on the assistant and every tool in
// vapi/setupAssistant.js.
export const vapiWebhookRouter = Router();

// The dashboard's stats (src/db.js) count drop-offs, missed calls and transfers using Retell's
// disconnection reasons, so map Vapi's endedReason values onto those.
export function normaliseEndedReason(reason) {
  if (!reason) return null;
  if (/forward|transfer/i.test(reason)) return 'call_transfer';
  if (reason === 'customer-ended-call') return 'user_hangup';
  if (reason === 'assistant-ended-call') return 'agent_hangup';
  if (/did-not-answer|no-answer/i.test(reason)) return 'dial_no_answer';
  if (/busy|failed-to-connect/i.test(reason)) return 'dial_failed';
  if (/voicemail/i.test(reason)) return 'voicemail_reached';
  return reason;
}

function baseCallRow(call) {
  return {
    call_id: call.id,
    agent_id: call.assistantId || null,
    from_number: call.customer?.number || null,
    to_number: call.phoneNumber?.number || null,
    started_at: call.startedAt ? Date.parse(call.startedAt) : Date.now(),
    intent: null,
  };
}

async function handleToolCalls(message) {
  const callId = message.call?.id ?? null;
  const results = await Promise.all(
    (message.toolCallList || []).map(async (toolCall) => {
      const name = toolCall.name ?? toolCall.function?.name;
      let args = toolCall.parameters ?? toolCall.function?.arguments ?? {};
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args);
        } catch {
          args = {};
        }
      }
      const output = await runTool(name, args, { callId });
      // Vapi wants `result` as a single-line string; the model reads the JSON just fine.
      return { name, toolCallId: toolCall.id, result: JSON.stringify(output) };
    })
  );
  return { results };
}

function handleStatusUpdate(message) {
  const { call, status } = message;
  if (!call?.id) return;
  upsertCall({
    ...baseCallRow(call),
    status: status === 'in-progress' ? 'in_progress' : status,
    ended_at: status === 'ended' ? Date.now() : null,
    disconnection_reason: normaliseEndedReason(message.endedReason ?? call.endedReason),
    transcript: null,
    recording_url: null,
    escalated: status === 'forwarding' ? 1 : 0,
  });
}

function handleEndOfCallReport(message) {
  const { call, artifact = {} } = message;
  if (!call?.id) return;
  const disconnection = normaliseEndedReason(message.endedReason ?? call.endedReason);

  // Vapi's own per-call average of turn latency (caller stops talking -> agent starts), in ms -
  // the number the case study quotes, so take it from Vapi rather than measuring it here.
  const latency = artifact.performanceMetrics?.turnLatencyAverage;

  upsertCall({
    ...baseCallRow(call),
    status: 'ended',
    ended_at: call.endedAt ? Date.parse(call.endedAt) : Date.now(),
    disconnection_reason: disconnection,
    transcript: artifact.transcript || null,
    recording_url: artifact.recording?.mono?.combinedUrl || artifact.recordingUrl || null,
    escalated: disconnection === 'call_transfer' ? 1 : 0,
    avg_response_latency_ms: Number.isFinite(latency) ? Math.round(latency) : null,
  });

  // Not awaited - Vapi doesn't need HubSpot's answer, and a slow CRM shouldn't hold the webhook.
  logCallToCrm({
    callId: call.id,
    fromNumber: call.customer?.number || null,
    toNumber: call.phoneNumber?.number || null,
    startedAt: call.startedAt ? Date.parse(call.startedAt) : null,
    endedAt: call.endedAt ? Date.parse(call.endedAt) : Date.now(),
    outcome: message.endedReason ?? call.endedReason ?? null,
    summary: message.analysis?.summary || message.summary || null,
    transcript: artifact.transcript || null,
    recordingUrl: artifact.recording?.mono?.combinedUrl || artifact.recordingUrl || null,
  }).catch((e) => console.error('[crm call log failed]', e.response?.data?.message || e.message));
}

vapiWebhookRouter.post('/', async (req, res) => {
  const message = req.body?.message;
  switch (message?.type) {
    case 'tool-calls':
      return res.json(await handleToolCalls(message));
    case 'status-update':
      handleStatusUpdate(message);
      break;
    case 'end-of-call-report':
      handleEndOfCallReport(message);
      console.log(`[vapi-webhook] end-of-call-report for call ${message.call?.id}`);
      break;
    default:
      // Other event types (speech-update, conversation-update, ...) aren't subscribed to, but
      // answer 200 so a dashboard config change can't make Vapi retry or error.
      break;
  }
  res.json({});
});
