import axios from 'axios';
import { config } from '../config.js';

const isLive = Boolean(config.hubspotApiKey);

const hubspot = axios.create({
  baseURL: 'https://api.hubapi.com/crm/v3/objects',
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
    const res = await hubspot.post('/contacts', { properties });
    return { crmId: res.data.id, mode: 'live' };
  } catch (err) {
    // HubSpot refuses a second contact with the same email (409 "Contact already exists.
    // Existing ID: 123") - returning callers are common, so update that contact instead.
    const existingId = err.response?.status === 409 && err.response.data?.message?.match(/Existing ID: (\d+)/)?.[1];
    if (!existingId) throw err;
    await hubspot.patch(`/contacts/${existingId}`, { properties });
    return { crmId: existingId, mode: 'live' };
  }
}

// HubSpot's built-in association type for call -> contact.
const CALL_TO_CONTACT = 194;

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

// hs_call_body is rendered as HTML on the contact's timeline.
export function buildCallProperties({ callId, fromNumber, toNumber, startedAt, endedAt, outcome, summary, transcript, recordingUrl }) {
  const body = [
    summary && `<p><strong>Summary</strong><br>${escapeHtml(summary)}</p>`,
    transcript && `<p><strong>Transcript</strong><br>${escapeHtml(transcript).replace(/\n/g, '<br>')}</p>`,
    `<p>Call ID: ${escapeHtml(callId)}</p>`,
  ]
    .filter(Boolean)
    .join('');

  return {
    hs_timestamp: new Date(startedAt || endedAt || Date.now()).toISOString(),
    hs_call_title: `AI receptionist call${outcome ? ` - ${outcome}` : ''}`,
    hs_call_direction: 'INBOUND',
    hs_call_status: 'COMPLETED',
    hs_call_body: body,
    hs_call_duration: startedAt && endedAt ? String(Math.max(0, endedAt - startedAt)) : undefined,
    hs_call_from_number: fromNumber || undefined,
    hs_call_to_number: toNumber || undefined,
    hs_call_recording_url: recordingUrl || undefined,
  };
}

async function findContactId(filters) {
  const res = await hubspot.post('/contacts/search', { filterGroups: [{ filters }], limit: 1 });
  return res.data.results[0]?.id ?? null;
}

// Any lead captured during the call was saved with this call_id; failing that, match the
// caller's number (web calls have none, so those calls are logged without a contact).
async function contactForCall(callId, fromNumber) {
  const byCall = callId && (await findContactId([{ propertyName: 'call_id', operator: 'EQ', value: callId }]));
  if (byCall) return byCall;
  if (!fromNumber) return null;
  return findContactId([{ propertyName: 'phone', operator: 'EQ', value: fromNumber }]);
}

export async function logCallToCrm(call) {
  const properties = buildCallProperties(call);
  if (!isLive) {
    console.log('[crm:mock] call logged', { callId: call.callId, title: properties.hs_call_title });
    return { crmId: null, mode: 'mock' };
  }

  const contactId = await contactForCall(call.callId, call.fromNumber);
  const associations = contactId
    ? [{ to: { id: contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: CALL_TO_CONTACT }] }]
    : [];
  const res = await hubspot.post('/calls', { properties, associations });
  return { crmId: res.data.id, contactId, mode: 'live' };
}

export const crmMode = isLive ? 'hubspot (live)' : 'mock (no HUBSPOT_API_KEY set)';
