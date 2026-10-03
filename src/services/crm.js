import axios from 'axios';
import { config } from '../config.js';

const isLive = Boolean(config.hubspotApiKey);

export async function pushLeadToCrm({ name, phone, email, treatmentInterest, budget, urgency, callId }) {
  if (!isLive) {
    console.log('[crm:mock] lead captured', { name, phone, email, treatmentInterest, budget, urgency, callId });
    return { crmId: null, mode: 'mock' };
  }

  const res = await axios.post(
    'https://api.hubapi.com/crm/v3/objects/contacts',
    {
      properties: {
        firstname: name,
        phone,
        email: email || undefined,
        treatment_interest: treatmentInterest,
        lead_budget: budget,
        lead_urgency: urgency,
        lead_source: 'ai_receptionist_call',
        call_id: callId,
      },
    },
    { headers: { Authorization: `Bearer ${config.hubspotApiKey}` }, timeout: 5000 }
  );
  return { crmId: res.data.id, mode: 'live' };
}

export const crmMode = isLive ? 'hubspot (live)' : 'mock (no HUBSPOT_API_KEY set)';
