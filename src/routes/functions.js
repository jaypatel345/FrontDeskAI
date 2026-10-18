import { Router } from 'express';
import { runTool } from '../tools/handlers.js';
import { getIndustry } from '../industries/registry.js';

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

function resolveIndustry(req) {
  const industryFromReq =
    req.params?.industry ||
    req.query?.industry ||
    req.headers?.['x-industry'] ||
    req.body?.industry ||
    req.body?.call?.industry ||
    req.body?.call?.to_number ||
    req.body?.call?.phoneNumber?.number;
  return getIndustry(industryFromReq);
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

// Handle standard paths /functions/:path
for (const [path, toolName] of Object.entries(ROUTES)) {
  functionsRouter.post(`/${path}`, async (req, res) => {
    const industry = resolveIndustry(req);
    res.json(await runTool(toolName, extractArgs(req), { callId: extractCallId(req), industryKey: industry.id }));
  });
}

// Handle explicit industry paths /functions/:industry/:path
for (const [path, toolName] of Object.entries(ROUTES)) {
  functionsRouter.post(`/:industry/${path}`, async (req, res) => {
    const industry = resolveIndustry(req);
    res.json(await runTool(toolName, extractArgs(req), { callId: extractCallId(req), industryKey: industry.id }));
  });
}

