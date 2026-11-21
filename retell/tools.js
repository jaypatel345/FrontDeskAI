import { config } from '../src/config.js';

const base = config.baseUrl;

// Sent on every tool call so the backend can reject anyone else hitting /functions/*.
const headers = config.functionsSecret ? { 'x-functions-secret': config.functionsSecret } : {};

export const searchKnowledgeBaseTool = {
  type: 'custom',
  headers,
  name: 'search_knowledge_base',
  url: `${base}/functions/search-knowledge-base`,
  description:
    'Clinic facts only: services, price ranges, doctors, hours, location, aftercare, FAQs. Knows nothing about open times or bookings - never use it for scheduling.',
  speak_during_execution: true,
  execution_message_description: 'Sure thing, let me check that for you right now.',
  // Headroom over the RAG service's own ~4s worst case (live Qdrant+OpenAI mode) so a slow
  // embedding call doesn't blow the tool's deadline before our JSON even leaves the server.
  timeout_ms: 6000,
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: "The patient's question, in their own words." },
    },
    required: ['query'],
  },
};

export const checkAvailabilityTool = {
  type: 'custom',
  headers,
  name: 'check_availability',
  url: `${base}/functions/check-availability`,
  description:
    'Open appointment times for a service - use for any booking or availability question, before you have a phone number. Already searches weeks ahead. Each slot has "start" (pass exactly to book_appointment) and "label" (say this aloud, never convert "start").',
  speak_during_execution: true,
  execution_message_description: "Give me just a second, let me check our latest calendar and find an appointment for you.",
  // Must stay above scheduling.js's own axios timeout (4000ms) to Cal.com, with headroom
  // for the ngrok hop + JSON round trip — equal values here is what caused real timeouts.
  timeout_ms: 7000,
  parameters: {
    type: 'object',
    properties: {
      service: { type: 'string', description: 'e.g. Botox, Filler, Laser Hair Removal, HydraFacial' },
      date_from: { type: 'string', description: 'ISO 8601. Default now.' },
      date_to: { type: 'string', description: 'ISO 8601. Optional.' },
    },
    required: ['service'],
  },
};

export const bookAppointmentTool = {
  type: 'custom',
  headers,
  name: 'book_appointment',
  url: `${base}/functions/book-appointment`,
  description:
    'Book a slot the caller agreed to from check_availability, once you have name, phone and email.',
  speak_during_execution: true,
  execution_message_description: "Awesome, I'm locking that appointment in for you right now.",
  // Above scheduling.js's bookSlot axios timeout (6000ms), with headroom.
  timeout_ms: 9000,
  parameters: {
    type: 'object',
    properties: {
      service: { type: 'string' },
      start_time: { type: 'string', description: 'Exact "start" value from check_availability.' },
      name: { type: 'string' },
      phone: { type: 'string', description: 'Phone number in E.164 format if possible.' },
      email: { type: 'string', description: 'Required. Ask for it.' },
    },
    required: ['service', 'start_time', 'name', 'phone', 'email'],
  },
};

export const captureLeadTool = {
  type: 'custom',
  headers,
  name: 'capture_lead',
  url: `${base}/functions/capture-lead`,
  description:
    'Save lead details as soon as you learn any, even before booking. Call again as you learn more.',
  speak_during_execution: false,
  timeout_ms: 3000,
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      phone: { type: 'string' },
      email: { type: 'string' },
      treatment_interest: { type: 'string' },
      budget: { type: 'string', description: 'Only if volunteered.' },
      urgency: { type: 'string', description: 'e.g. "this week", "just researching", "event in 2 weeks"' },
    },
    required: [],
  },
};

export const lookupAppointmentTool = {
  type: 'custom',
  headers,
  name: 'lookup_appointment',
  url: `${base}/functions/lookup-appointment`,
  description:
    "Find an appointment the caller says they already have. Not part of booking a new one.",
  speak_during_execution: true,
  execution_message_description: 'Let me pull up your appointment details.',
  timeout_ms: 5000,
  parameters: {
    type: 'object',
    properties: {
      phone: { type: 'string', description: 'Phone the booking is under.' },
    },
    required: ['phone'],
  },
};

export const cancelAppointmentTool = {
  type: 'custom',
  headers,
  name: 'cancel_appointment',
  url: `${base}/functions/cancel-appointment`,
  description: "Cancel the caller's existing upcoming appointment. Confirm out loud before calling this.",
  speak_during_execution: true,
  execution_message_description: "I'm processing that cancellation for you now.",
  // Above scheduling.js's cancelBooking axios timeout (6000ms) - was 5000 here, which was
  // actually *below* the axios timeout it wraps, guaranteeing a Retell-side timeout first.
  timeout_ms: 9000,
  parameters: {
    type: 'object',
    properties: {
      phone: { type: 'string', description: 'Phone the booking is under.' },
    },
    required: ['phone'],
  },
};

export const rescheduleAppointmentTool = {
  type: 'custom',
  headers,
  name: 'reschedule_appointment',
  url: `${base}/functions/reschedule-appointment`,
  description:
    "Move an existing appointment to a new slot from check_availability, after confirming it out loud.",
  speak_during_execution: true,
  execution_message_description: "I'm rescheduling that for you right now.",
  // This tool runs cancel then book SEQUENTIALLY server-side (see reschedule-appointment in
  // src/routes/functions.js) - worst case is both axios timeouts back to back (~12s), so this
  // needs real headroom above that, not just above a single call.
  timeout_ms: 15000,
  parameters: {
    type: 'object',
    properties: {
      phone: { type: 'string', description: 'Phone the booking is under.' },
      new_start_time: { type: 'string', description: 'Exact "start" value from check_availability.' },
    },
    required: ['phone', 'new_start_time'],
  },
};

export const updateAppointmentDetailsTool = {
  type: 'custom',
  headers,
  name: 'update_appointment_details',
  url: `${base}/functions/update-appointment-details`,
  description:
    "Correct the name, email or phone on an existing booking. Never call book_appointment again for this. Time stays the same.",
  speak_during_execution: true,
  execution_message_description: "I'm updating that now.",
  // Same cancel-then-rebook pattern as reschedule - needs the same generous headroom.
  timeout_ms: 15000,
  parameters: {
    type: 'object',
    properties: {
      phone: { type: 'string', description: 'Phone number the booking is currently under (to find it).' },
      new_name: { type: 'string', description: 'Corrected name, if that is what is being fixed.' },
      new_email: { type: 'string', description: 'Corrected email, if that is what is being fixed.' },
      new_phone: { type: 'string', description: 'A new phone number, if that is what is being fixed (rare).' },
    },
    required: ['phone'],
  },
};

export const transferCallTool = {
  type: 'transfer_call',
  name: 'transfer_to_front_desk',
  description:
    'Transfer the call to a human front-desk team member. Use immediately for: an angry or upset patient, a complex medical question you cannot answer from the knowledge base, or any explicit request for a human.',
  transfer_destination: { type: 'predefined', number: config.humanTransferNumber },
  transfer_option: { type: 'cold_transfer' },
};

export const endCallTool = {
  type: 'end_call',
  name: 'end_call',
  description: "End the call politely once the patient's request has been fully handled and they have nothing else to ask.",
};

// lookup/cancel/reschedule are general tools, not scoped to one state - "check/cancel my
// appointment" kept surfacing in whatever state the LLM happened to route to (faq_inquiry,
// human_escalation, etc), and state-scoped tools meant it had no way to act there. Rather than
// keep patching every state's edges, make these three available everywhere, same as transfer/end.
export const generalTools = [
  transferCallTool,
  endCallTool,
  lookupAppointmentTool,
  cancelAppointmentTool,
  rescheduleAppointmentTool,
  updateAppointmentDetailsTool,
];
