import axios from 'axios';
import { config } from '../src/config.js';

if (!config.hubspotApiKey) {
  console.error('HUBSPOT_API_KEY is not set in .env.');
  process.exit(1);
}

const http = axios.create({
  baseURL: 'https://api.hubapi.com',
  headers: { Authorization: `Bearer ${config.hubspotApiKey}`, 'Content-Type': 'application/json' },
});

// HubSpot rejects writes to unknown custom properties (PROPERTY_DOESNT_EXIST) rather than
// auto-creating them - these have to be registered once before src/services/crm.js can use them.
const properties = [
  { name: 'treatment_interest', label: 'Treatment Interest', type: 'string', fieldType: 'text' },
  { name: 'lead_budget', label: 'Lead Budget', type: 'string', fieldType: 'text' },
  { name: 'lead_urgency', label: 'Lead Urgency', type: 'string', fieldType: 'text' },
  { name: 'lead_source', label: 'Lead Source', type: 'string', fieldType: 'text' },
  { name: 'call_id', label: 'Call ID', type: 'string', fieldType: 'text' },
];

async function ensureProperty(prop) {
  try {
    await http.get(`/crm/v3/properties/contacts/${prop.name}`);
    console.log(`  already exists: ${prop.name}`);
  } catch (err) {
    if (err.response?.status !== 404) throw err;
    await http.post('/crm/v3/properties/contacts', { ...prop, groupName: 'contactinformation' });
    console.log(`  created: ${prop.name}`);
  }
}

async function main() {
  console.log('Ensuring HubSpot contact properties exist...');
  for (const prop of properties) {
    await ensureProperty(prop);
  }
  console.log('Done.');
}

main().catch((err) => {
  console.error('Failed:', err.response?.data || err.message);
  process.exit(1);
});
