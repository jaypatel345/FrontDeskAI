import fs from 'node:fs';
import axios from 'axios';
import { config } from '../src/config.js';
import { task } from './prompt.js';
import { allTools } from './tools.js';

const CONFIG_FILE = new URL('./.agent-config.json', import.meta.url);

if (!config.bland.apiKey) {
  console.error('BLAND_API_KEY is not set in .env — get it from the Bland dashboard first.');
  process.exit(1);
}
if (config.baseUrl.includes('localhost')) {
  console.warn('WARNING: BASE_URL is still localhost — Bland cannot reach your machine. Point it at your ngrok/deployed URL before running this.');
}

const http = axios.create({
  baseURL: 'https://api.bland.ai',
  headers: { Authorization: config.bland.apiKey, 'Content-Type': 'application/json' },
});

const agentPayload = {
  task,
  voice: config.bland.voiceId || undefined,
  tools: allTools,
  transfer_phone_number: config.humanTransferNumber,
  record: true,
  interruption_threshold: 100,
  max_duration: 15,
  webhook: `${config.baseUrl}/webhooks/bland`,
};

fs.writeFileSync(CONFIG_FILE, JSON.stringify(agentPayload, null, 2));
console.log(`Wrote full agent config to ${CONFIG_FILE.pathname}`);

async function main() {
  if (!config.bland.phoneNumber) {
    console.log('\nNo BLAND_PHONE_NUMBER set — nothing to attach this config to yet.');
    console.log('1. Buy or import a number in the Bland dashboard (Numbers tab).');
    console.log('2. Set BLAND_PHONE_NUMBER in .env to that number, then re-run: npm run setup:bland-agent');
    console.log('   (Or paste the `task` and `tools` fields from bland/.agent-config.json directly into');
    console.log('    the dashboard\'s inbound agent builder if the API route below is unavailable.)');
    return;
  }

  try {
    await http.post('/v1/inbound-number-update', {
      phone_number: config.bland.phoneNumber,
      ...agentPayload,
    });
    console.log(`\nUpdated inbound agent for ${config.bland.phoneNumber}.`);
    console.log('Call that number to test — or use the Bland dashboard\'s test-call feature if available.');
  } catch (err) {
    console.error('\nSetup failed:', err.response?.data || err.message);
    console.error('If this account is still under verification hold, config writes may be blocked too —');
    console.error('bland/.agent-config.json still has the full config ready to paste into the dashboard');
    console.error('or re-run this script once the hold clears.');
    console.error('\nIf field names have drifted from what this script expects, cross-check against');
    console.error('https://docs.bland.ai/tutorials/custom-tools and https://docs.bland.ai/api-v1/post/inbound-number-update');
    process.exit(1);
  }
}

main();
