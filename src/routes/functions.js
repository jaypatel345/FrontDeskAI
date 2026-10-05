import { Router } from 'express';
import { runTool } from '../tools/handlers.js';

export { searchWindowEnd } from '../tools/handlers.js';

// One route per tool, the shape Retell and Bland custom tools expect. The tool logic itself
// lives in src/tools/handlers.js, shared with the Vapi webhook.
export const functionsRouter = Router();

// Retell posts either { call, name, args } or (if "payload: args only" is on) just the args object.
function extractArgs(req) {
  return req.body?.args ?? req.body ?? {};
}
function extractCallId(req) {
  return req.body?.call?.call_id ?? req.body?.call_id ?? null;
}

const ROUTES = {
  'check-availability': 'check_availability',
  'book-appointment': 'book_appointment',
  'search-knowledge-base': 'search_knowledge_base',
  'capture-lead': 'capture_lead',
  'lookup-appointment': 'lookup_appointment',
  'cancel-appointment': 'cancel_appointment',
  'reschedule-appointment': 'reschedule_appointment',
  'update-appointment-details': 'update_appointment_details',
};

for (const [path, toolName] of Object.entries(ROUTES)) {
  functionsRouter.post(`/${path}`, async (req, res) => {
    res.json(await runTool(toolName, extractArgs(req), { callId: extractCallId(req) }));
  });
}
