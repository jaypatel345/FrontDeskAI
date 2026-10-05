import axios from 'axios';
import { config } from '../config.js';

const isLive = Boolean(config.hubspotApiKey);

const hubspot = axios.create({
  baseURL: 'https://api.hubapi.com/crm/v3/objects/contacts',
  headers: { Authorization: `Bearer ${config.hubspotApiKey}` },
  timeout: 5000,
});

export async function pushLeadToCrm({ name, phone, email, treatmentInterest, budget, urgency, callId }) {
  if (!isLive) {
    console.log('[crm:mock] lead captured', { name, phone, email, treatmentInterest, budget, urgency, callId });
    return { crmId: null, mode: 'mock' };
  }

  const properties = {
    firstname: name,
    phone,
    email: email || undefined,
    treatment_interest: treatmentInterest,
    lead_budget: budget,
    lead_urgency: urgency,
    lead_source: 'ai_receptionist_call',
    call_id: callId,
  };

  try {
    const res = await hubspot.post('', { properties });
    return { crmId: res.data.id, mode: 'live' };
  } catch (err) {
    // HubSpot refuses a second contact with the same email (409 "Contact already exists.
    // Existing ID: 123") - returning callers are common, so update that contact instead.
    const existingId = err.response?.status === 409 && err.response.data?.message?.match(/Existing ID: (\d+)/)?.[1];
    if (!existingId) throw err;
    await hubspot.patch(`/${existingId}`, { properties });
    return { crmId: existingId, mode: 'live' };
  }
}

export const crmMode = isLive ? 'hubspot (live)' : 'mock (no HUBSPOT_API_KEY set)';
