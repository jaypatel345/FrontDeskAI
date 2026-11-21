// Compares LLMs for the receptionist through Vapi's text chat API (no phone needed): same prompt,
// same tools, same scripted caller turns. Reports wall time per turn and whether the right tool
// was (or wasn't) called. Wall time includes Vapi's overhead and any tool round trip, so compare
// models against each other, not against voice turn latency.
// Usage: npm run bench:models [-- openai:gpt-4.1-nano groq:llama-3.3-70b-versatile ...]
// Costs a fraction of a cent per turn on your Vapi balance. Never books anything.
import { config } from '../src/config.js';
import { assistant } from '../vapi/assistant.js';

if (!config.vapi.privateKey) {
  console.error('VAPI_PRIVATE_KEY is not set in .env.');
  process.exit(1);
}

const models = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['openai:gpt-4.1-mini', 'openai:gpt-4.1-nano', 'openai:gpt-4o-mini'];

// expectTool: tool that must be called; forbidTools: tools that must not be called.
const SCENARIOS = [
  { name: 'greeting', input: 'Hi there.', forbidTools: ['book_appointment', 'cancel_appointment'] },
  { name: 'price question', input: 'How much is Botox?', expectTool: 'search_knowledge_base' },
  { name: 'booking intent', input: 'Can I get a HydraFacial sometime next week?', expectTool: 'check_availability', forbidTools: ['search_knowledge_base'] },
  { name: 'cancel needs confirm', input: 'I need to cancel my appointment.', forbidTools: ['cancel_appointment'] },
  { name: 'medical question', input: 'Is Botox safe with my blood pressure medication?', forbidTools: ['book_appointment'], forbidReply: /\b(is|are) (generally |usually |perfectly )?safe\b|you should avoid/i },
];
const REPEATS = 2;

async function chat(model) {
  const [provider, ...rest] = model.split(':');
  const body = {
    assistant: { ...assistant, model: { ...assistant.model, provider, model: rest.join(':') } },
  };
  return body;
}

async function runTurn(model, scenario) {
  const base = await chat(model);
  const t0 = performance.now();
  const res = await fetch('https://api.vapi.ai/chat', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.vapi.privateKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...base, input: scenario.input }),
  });
  const ms = Math.round(performance.now() - t0);
  const data = await res.json();
  if (!res.ok) return { ms, error: data.message || JSON.stringify(data).slice(0, 200) };

  const out = data.output || [];
  const called = out.flatMap((m) => (m.tool_calls || m.toolCalls || []).map((t) => t.function?.name || t.name));
  const reply = out.filter((m) => m.role === 'assistant' && m.content).map((m) => m.content).pop() || '';
  let ok = true;
  if (scenario.expectTool && !called.includes(scenario.expectTool)) ok = false;
  if (scenario.forbidTools?.some((t) => called.includes(t))) ok = false;
  if (scenario.forbidReply?.test(reply)) ok = false;
  return { ms, called, reply, ok };
}

// Wake the backend first so a sleeping Render instance doesn't land on the first model's numbers.
await fetch(`${config.baseUrl}/health`).catch(() => {});

const summary = [];
for (const model of models) {
  console.log(`\n=== ${model} ===`);
  const times = [];
  let passed = 0;
  let total = 0;
  for (const scenario of SCENARIOS) {
    for (let i = 0; i < REPEATS; i++) {
      const r = await runTurn(model, scenario);
      total++;
      if (r.error) {
        console.log(`  ${scenario.name.padEnd(22)} ERROR ${r.error}`);
        continue;
      }
      times.push(r.ms);
      if (r.ok) passed++;
      console.log(`  ${scenario.name.padEnd(22)} ${String(r.ms).padStart(6)}ms ${r.ok ? 'ok  ' : 'FAIL'} [${r.called.join(', ')}] ${r.reply.slice(0, 90)}`);
    }
  }
  times.sort((a, b) => a - b);
  const median = times.length ? times[Math.floor(times.length / 2)] : null;
  summary.push({ model, median, passed, total });
}

console.log('\nmodel                              median ms   correct');
for (const s of summary) console.log(`${s.model.padEnd(36)} ${String(s.median ?? '-').padStart(8)}   ${s.passed}/${s.total}`);
