import fs from 'node:fs';
import axios from 'axios';
import { config } from '../src/config.js';
import { normalizeIndustryKey, listIndustryIds } from '../src/industries/registry.js';

if (!config.vapi.privateKey) {
  console.error('VAPI_PRIVATE_KEY is not set in .env');
  process.exit(1);
}

const http = axios.create({
  baseURL: 'https://api.vapi.ai',
  headers: { Authorization: `Bearer ${config.vapi.privateKey}`, 'Content-Type': 'application/json' },
});

function getAssistantIdForIndustry(industryKey) {
  const filename =
    industryKey === 'clinic'
      ? '../vapi/.deployed-assistant.json'
      : `../vapi/.deployed-assistant-${industryKey}.json`;
  const fileUrl = new URL(filename, import.meta.url);
  if (!fs.existsSync(fileUrl)) return null;
  const data = JSON.parse(fs.readFileSync(fileUrl, 'utf-8'));
  return data.assistant_id || null;
}

async function main() {
  const rawArg = process.argv[2] ? process.argv[2].replace(/^--industry=/, '').trim().toLowerCase() : null;
  const targetIndustry = normalizeIndustryKey(rawArg);

  if (!targetIndustry) {
    console.log(`\nUsage: npm run switch:phone [clinic | real-estate | general-business]`);
    console.log(`Available options: ${listIndustryIds().join(', ')}`);
    process.exit(1);
  }

  const assistantId = getAssistantIdForIndustry(targetIndustry);
  if (!assistantId) {
    console.error(`No deployed assistant found for "${targetIndustry}". Run "npm run setup:vapi:${targetIndustry}" first.`);
    process.exit(1);
  }

  // Get active phone numbers in Vapi
  const phoneRes = await http.get('/phone-number');
  const numbers = phoneRes.data;

  if (!numbers || numbers.length === 0) {
    console.error('No phone numbers found in your Vapi account.');
    process.exit(1);
  }

  const targetNumber = numbers[0]; // Active phone number (+17752097469)

  await http.patch(`/phone-number/${targetNumber.id}`, {
    assistantId,
    name: `${targetIndustry.toUpperCase()} Demo Line`,
  });

  console.log(`\n✅ Phone Number ${targetNumber.number} successfully switched to [${targetIndustry.toUpperCase()}]!`);
  console.log(`   Assistant ID: ${assistantId}`);
  console.log(`\nCall ${targetNumber.number} now to test the ${targetIndustry} receptionist directly from your phone!`);
}

main().catch((err) => {
  console.error('Failed to switch phone number:', err.response?.data || err.message);
  process.exit(1);
});
