import fs from 'node:fs';
import axios from 'axios';
import { config } from '../src/config.js';
import { assistant } from './assistant.js';

const STATE_FILE = new URL('./.deployed-assistant.json', import.meta.url);

if (!config.vapi.privateKey) {
  console.error('VAPI_PRIVATE_KEY is not set in .env — copy the private key from the Vapi dashboard (Organization > API Keys).');
  process.exit(1);
}
if (config.baseUrl.includes('localhost')) {
  console.warn('WARNING: BASE_URL is still localhost — Vapi cannot reach your machine. Point it at your ngrok/deployed URL first.');
}
if (!config.functionsSecret) {
  console.warn('WARNING: FUNCTIONS_SECRET is not set — the assistant will call your server without a secret.');
}

const http = axios.create({
  baseURL: 'https://api.vapi.ai',
  headers: { Authorization: `Bearer ${config.vapi.privateKey}`, 'Content-Type': 'application/json' },
});

async function main() {
  const existing = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) : null;

  // Idempotent like retell/setupAgent.js: update the assistant created last time instead of
  // making a duplicate on every run.
  let assistantId;
  if (existing?.assistant_id) {
    await http.patch(`/assistant/${existing.assistant_id}`, assistant);
    assistantId = existing.assistant_id;
    console.log(`Updated existing assistant ${assistantId}`);
  } else {
    const res = await http.post('/assistant', assistant);
    assistantId = res.data.id;
    console.log(`Created assistant ${assistantId}`);
  }

  fs.writeFileSync(STATE_FILE, JSON.stringify({ assistant_id: assistantId }, null, 2));
  console.log(`\nTools and call events go to: ${config.baseUrl}/webhooks/vapi`);
  console.log('\nDone. In the Vapi dashboard (dashboard.vapi.ai > Assistants):');
  console.log(`  - Open "${assistant.name}" and press "Talk to Assistant" for a browser test call - no phone number needed.`);
  console.log('  - Call logs (transcript, recording, latency per turn) are under Observe > Call Logs.');
}

main().catch((err) => {
  console.error('Setup failed:', JSON.stringify(err.response?.data ?? err.message, null, 2));
  console.error('\nIf a field name has drifted, check https://docs.vapi.ai/api-reference/assistants/create');
  process.exit(1);
});
