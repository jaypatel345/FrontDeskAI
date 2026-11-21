import { Router } from 'express';
import { config } from '../config.js';
import { getOrBuildDemoProfile, demoVariables, registerDemoCall } from '../services/demoProfiles.js';

// Public API for the Upper Layer Studio demo page (and the outreach script that pre-builds
// profiles): website -> personalised demo profile + the prompt variables to start a call with.
export const demoRouter = Router();

// Only the demo page's own origins may call this from a browser.
demoRouter.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && config.demo.allowedOrigins.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(origin && config.demo.allowedOrigins.includes(origin) ? 204 : 403);
  next();
});

const OVERRIDE_KEYS = ['name', 'city', 'niche', 'doctor', 'language'];
const pickOverrides = (src = {}) =>
  Object.fromEntries(OVERRIDE_KEYS.filter((k) => typeof src[k] === 'string').map((k) => [k, src[k].slice(0, 120)]));

function reply(res, found) {
  res.json({ id: found.id, profile: found.profile, variables: demoVariables(found.id, found.profile), ...(found.error ? { warning: found.error } : {}) });
}

// POST { url, name?, city?, niche?, doctor?, language? } -> { id, profile, variables }
demoRouter.post('/profiles', async (req, res) => {
  const { url } = req.body || {};
  if (typeof url !== 'string' || !url.trim()) return res.status(400).json({ error: 'url is required' });
  try {
    reply(res, await getOrBuildDemoProfile({ url: url.slice(0, 500), overrides: pickOverrides(req.body) }));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

demoRouter.get('/profiles/:id', async (req, res) => {
  const found = await getOrBuildDemoProfile({ id: req.params.id, overrides: pickOverrides(req.query) }).catch(() => null);
  if (!found) return res.status(404).json({ error: 'Unknown demo - build it again from its url.' });
  reply(res, found);
});

// The demo page reports which call belongs to which demo, as a fallback for tool-call webhooks
// that don't carry the call's variables.
demoRouter.post('/calls', (req, res) => {
  const { callId, demoId } = req.body || {};
  if (typeof callId !== 'string' || typeof demoId !== 'string' || callId.length > 100 || demoId.length > 40) {
    return res.status(400).json({ error: 'callId and demoId are required' });
  }
  registerDemoCall(callId, demoId);
  res.json({ ok: true });
});
