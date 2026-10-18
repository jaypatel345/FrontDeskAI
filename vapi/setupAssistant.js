import fs from 'node:fs';
import axios from 'axios';
import { config } from '../src/config.js';
import { getVapiAssistant, assistant as defaultAssistant } from './assistant.js';
import { listIndustryIds, normalizeIndustryKey } from '../src/industries/registry.js';

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

function getStateFile(industryKey) {
  return industryKey === 'clinic'
    ? new URL('./.deployed-assistant.json', import.meta.url)
    : new URL(`./.deployed-assistant-${industryKey}.json`, import.meta.url);
}

async function setupSingleAssistant(industryKey) {
  const assistantPayload = industryKey === 'clinic' ? defaultAssistant : getVapiAssistant(industryKey);
  const stateFile = getStateFile(industryKey);
  const existing = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf-8')) : null;

  console.log(`\n--- Setting up Vapi Assistant for [${industryKey}]: "${assistantPayload.name}" ---`);
  let assistantId;
  if (existing?.assistant_id) {
    await http.patch(`/assistant/${existing.assistant_id}`, assistantPayload);
    assistantId = existing.assistant_id;
    console.log(`Updated existing assistant ${assistantId}`);
  } else {
    const res = await http.post('/assistant', assistantPayload);
    assistantId = res.data.id;
    console.log(`Created assistant ${assistantId}`);
  }

  fs.writeFileSync(stateFile, JSON.stringify({ assistant_id: assistantId, industry: industryKey }, null, 2));
  console.log(`Tools and call events go to: ${config.baseUrl}/webhooks/vapi/${industryKey}`);
  console.log(`Open "${assistantPayload.name}" in Vapi dashboard to test!`);
  return assistantId;
}

async function main() {
  const rawArg = process.argv[2] ? process.argv[2].replace(/^--industry=/, '').trim().toLowerCase() : null;

  if (rawArg === 'all') {
    for (const key of listIndustryIds()) {
      await setupSingleAssistant(key);
    }
  } else if (rawArg) {
    const norm = normalizeIndustryKey(rawArg);
    if (!norm) {
      console.error(`Unknown industry "${rawArg}". Available: ${listIndustryIds().join(', ')}, all`);
      process.exit(1);
    }
    await setupSingleAssistant(norm);
  } else {
    // Default to clinic for backward compatibility
    await setupSingleAssistant('clinic');
  }

  console.log('\nAll done.');
}

main().catch((err) => {
  console.error('Setup failed:', JSON.stringify(err.response?.data ?? err.message, null, 2));
  process.exit(1);
});

