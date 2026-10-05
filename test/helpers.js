import './setup.js';
import { after } from 'node:test';
import request from 'supertest';
import { app } from '../src/app.js';
import { redis } from '../src/services/cache.js';

export { app };

// The Redis client keeps retrying in the background and would stop the test process exiting.
after(() => redis.disconnect());

// POST a tool call the way Retell sends it: { call, name, args } plus the shared-secret header.
export function callTool(path, args, { callId = 'test-call', secret = process.env.FUNCTIONS_SECRET } = {}) {
  const req = request(app).post(`/functions/${path}`).set('Content-Type', 'application/json');
  if (secret) req.set('x-functions-secret', secret);
  return req.send({ call: { call_id: callId }, args });
}

// An ISO time `days` from now at `hour`:00 UTC - always in the future, so booking validation accepts it.
export function futureIso(days, hour = 17) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
}
