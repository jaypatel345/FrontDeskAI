// Read-only latency report from Vapi's own call logs: average time per stage over the last N
// calls that have performance metrics. Usage: npm run latency [-- 20] [-- --assistant <id>]
import { config } from '../src/config.js';

if (!config.vapi.privateKey) {
  console.error('VAPI_PRIVATE_KEY is not set in .env.');
  process.exit(1);
}

const args = process.argv.slice(2);
const limit = Number(args.find((a) => /^\d+$/.test(a))) || 15;
const assistantIdx = args.indexOf('--assistant');
const assistantId = assistantIdx >= 0 ? args[assistantIdx + 1] : null;

const STAGES = ['turn', 'model', 'voice', 'transcriber', 'endpointing', 'fromTransport', 'toTransport'];

const url = new URL('https://api.vapi.ai/call');
url.searchParams.set('limit', '100');
if (assistantId) url.searchParams.set('assistantId', assistantId);

const res = await fetch(url, { headers: { Authorization: `Bearer ${config.vapi.privateKey}` } });
if (!res.ok) {
  console.error(`Vapi API ${res.status}: ${await res.text()}`);
  process.exit(1);
}
const body = await res.json();
const calls = (Array.isArray(body) ? body : body.results || [])
  .map((c) => ({ c, pm: c.artifact?.performanceMetrics || {} }))
  // Calls that ended before the first full turn report zeros - they'd drag every average down.
  .filter(({ pm }) => pm.turnLatencyAverage > 0 && pm.modelLatencyAverage > 0)
  .slice(0, limit);

if (!calls.length) {
  console.log('No calls with latency metrics yet.');
  process.exit(0);
}

const pad = (v, n = 8) => String(v).padStart(n);
console.log(`Last ${calls.length} calls${assistantId ? ` for assistant ${assistantId}` : ''}\n`);
console.log('created           ' + STAGES.map((s) => pad(s.replace('Transport', 'Tx'), 12)).join(''));
for (const { c, pm } of calls) {
  console.log(String(c.createdAt).slice(0, 16).padEnd(18) + STAGES.map((s) => pad(Math.round(pm[`${s}LatencyAverage`] ?? 0), 12)).join(''));
}
const avg = (s) => Math.round(calls.reduce((a, { pm }) => a + (pm[`${s}LatencyAverage`] ?? 0), 0) / calls.length);
console.log('-'.repeat(18 + 12 * STAGES.length));
console.log('AVERAGE (ms)'.padEnd(18) + STAGES.map((s) => pad(avg(s), 12)).join(''));
