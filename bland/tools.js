import { config } from '../src/config.js';

const base = config.baseUrl;

// Sent on every tool call so the backend can reject anyone else hitting /functions/*.
const headers = {
  'Content-Type': 'application/json',
  ...(config.functionsSecret ? { 'x-functions-secret': config.functionsSecret } : {}),
};

// Bland's tool schema: https://docs.bland.ai/tutorials/custom-tools
// body uses {{input.<field>}} templating filled from what the LLM extracted against
// input_schema; response uses JSONPath to pull values back out into named variables the
// agent can reference in speech afterward. Field names here match src/routes/functions.js
// exactly, since Bland posts `body` as the whole webhook payload (no {call,name,args} wrapper) —
// the same reason extractArgs() in that file falls back to the raw body.

export const searchKnowledgeBaseTool = {
  name: 'search_knowledge_base',
  description:
    'Look up clinic info: services, price RANGES, doctor profiles, hours/location, pre/post-care instructions, and general FAQs. Always use this instead of guessing.',
  speech: 'Let me check that for you.',
  url: `${base}/functions/search-knowledge-base`,
  method: 'POST',
  headers,
  body: { query: '{{input.query}}' },
  input_schema: {
    type: 'object',
    required: ['query'],
    properties: {
      query: { type: 'string', description: "The patient's question, in their own words." },
    },
  },
  response: { kb_answer: '$.results[0].info' },
  timeout: 4000,
};

export const checkAvailabilityTool = {
  name: 'check_availability',
  description: 'Check open appointment slots for a given service over the next few days.',
  speech: 'Let me check the calendar.',
  url: `${base}/functions/check-availability`,
  method: 'POST',
  headers,
  body: { service: '{{input.service}}', date_from: '{{input.date_from}}', date_to: '{{input.date_to}}' },
  input_schema: {
    type: 'object',
    required: ['service'],
    properties: {
      service: { type: 'string', description: 'e.g. Botox, Filler, Laser Hair Removal, HydraFacial' },
      date_from: { type: 'string', description: 'ISO 8601 datetime to start searching from. Default to now.' },
      date_to: { type: 'string', description: 'ISO 8601 datetime to search up to. Default to 5 days out.' },
    },
  },
  response: {
    available: '$.available',
    slot_1: '$.slots[0].start',
    slot_2: '$.slots[1].start',
    slot_3: '$.slots[2].start',
  },
  timeout: 4000,
};

export const bookAppointmentTool = {
  name: 'book_appointment',
  description:
    'Book a confirmed appointment slot. Only call after the patient explicitly agreed to a specific time from check_availability, and you have their name and phone number.',
  speech: "I'm booking that now.",
  url: `${base}/functions/book-appointment`,
  method: 'POST',
  headers,
  body: {
    call_id: '{{call_id}}',
    service: '{{input.service}}',
    start_time: '{{input.start_time}}',
    name: '{{input.name}}',
    phone: '{{input.phone}}',
    email: '{{input.email}}',
  },
  input_schema: {
    type: 'object',
    required: ['service', 'start_time', 'name', 'phone'],
    properties: {
      service: { type: 'string' },
      start_time: { type: 'string', description: 'ISO 8601 datetime of the exact slot the patient agreed to.' },
      name: { type: 'string' },
      phone: { type: 'string', description: 'Phone number in E.164 format if possible.' },
      email: { type: 'string', description: 'Optional.' },
    },
  },
  response: { success: '$.success', confirmation_message: '$.message' },
  timeout: 6000,
};

export const rescheduleAppointmentTool = {
  name: 'reschedule_appointment',
  description:
    "Move the caller's existing appointment to a new time. Use check_availability first, confirm the new slot out loud, then call this.",
  speech: "I'm moving that for you.",
  url: `${base}/functions/reschedule-appointment`,
  method: 'POST',
  headers,
  body: { call_id: '{{call_id}}', phone: '{{input.phone}}', new_start_time: '{{input.new_start_time}}' },
  input_schema: {
    type: 'object',
    required: ['phone', 'new_start_time'],
    properties: {
      phone: { type: 'string', description: 'Phone number the original booking was made under.' },
      new_start_time: { type: 'string', description: 'ISO 8601 datetime of the new agreed slot.' },
    },
  },
  response: { success: '$.success', confirmation_message: '$.message' },
  timeout: 6000,
};

export const cancelAppointmentTool = {
  name: 'cancel_appointment',
  description: "Cancel the caller's existing upcoming appointment. Confirm out loud before calling this.",
  speech: "I'm cancelling that now.",
  url: `${base}/functions/cancel-appointment`,
  method: 'POST',
  headers,
  body: { phone: '{{input.phone}}' },
  input_schema: {
    type: 'object',
    required: ['phone'],
    properties: {
      phone: { type: 'string', description: 'Phone number the original booking was made under.' },
    },
  },
  response: { success: '$.success', confirmation_message: '$.message' },
  timeout: 5000,
};

export const captureLeadTool = {
  name: 'capture_lead',
  description:
    'Save lead/qualification details as soon as you learn them, even before booking — ensures follow-up happens. Call again to update.',
  speech: '',
  url: `${base}/functions/capture-lead`,
  method: 'POST',
  headers,
  body: {
    call_id: '{{call_id}}',
    name: '{{input.name}}',
    phone: '{{input.phone}}',
    email: '{{input.email}}',
    treatment_interest: '{{input.treatment_interest}}',
    budget: '{{input.budget}}',
    urgency: '{{input.urgency}}',
  },
  input_schema: {
    type: 'object',
    required: [],
    properties: {
      name: { type: 'string' },
      phone: { type: 'string' },
      email: { type: 'string' },
      treatment_interest: { type: 'string' },
      budget: { type: 'string', description: 'Loose signal only if volunteered, e.g. "under $500". Never pressure for this.' },
      urgency: { type: 'string', description: 'e.g. "this week", "just researching"' },
    },
  },
  response: { success: '$.success' },
  timeout: 3000,
};

export const allTools = [
  searchKnowledgeBaseTool,
  checkAvailabilityTool,
  bookAppointmentTool,
  rescheduleAppointmentTool,
  cancelAppointmentTool,
  captureLeadTool,
];
