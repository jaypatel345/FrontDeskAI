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
    'Look up clinic info ONLY: services, price RANGES, doctor profiles, hours/location, pre/post-care instructions, general FAQs (pain, recovery, side effects). Does NOT know appointment availability, open slots, or existing bookings - never call this for "can I book", "do you have availability", or anything about scheduling a time. top_k is fixed at 3 server-side to keep latency low.',
  speak_during_execution: true,
  execution_message_description: 'Let me check that for you.',
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
    'THE tool for "can I book", "do you have availability", or scheduling a NEW visit - call this directly, not search_knowledge_base, even before you have the caller\'s phone number (phone is only needed later for book_appointment). Checks open appointment slots for a given service; the search already looks several weeks ahead automatically, so pass your best-guess date_from/date_to and trust the results. Each returned slot has "start" (ISO, pass exactly this back to book_appointment) and "label" (the correct spoken time in the clinic\'s timezone, e.g. "2:30 PM") - always read the label aloud, never compute your own AM/PM conversion from "start".',
  speak_during_execution: true,
  execution_message_description: 'Let me check the calendar.',
  // Must stay above scheduling.js's own axios timeout (4000ms) to Cal.com, with headroom
  // for the ngrok hop + JSON round trip — equal values here is what caused real timeouts.
  timeout_ms: 7000,
  parameters: {
    type: 'object',
    properties: {
      service: { type: 'string', description: 'e.g. Botox, Filler, Laser Hair Removal, HydraFacial' },
      date_from: { type: 'string', description: 'ISO 8601 datetime to start searching from. Default to now if the patient has no preference.' },
      date_to: { type: 'string', description: 'ISO 8601 datetime to search up to. Default to 5 days from date_from.' },
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
    'Book a confirmed appointment slot. Only call this after the patient has explicitly agreed to a specific time from check_availability, and you have their name and phone number.',
  speak_during_execution: true,
  execution_message_description: "I'm booking that now.",
  // Above scheduling.js's bookSlot axios timeout (6000ms), with headroom.
  timeout_ms: 9000,
  parameters: {
    type: 'object',
    properties: {
      service: { type: 'string' },
      start_time: { type: 'string', description: 'The exact "start" ISO value the patient agreed to from check_availability - copy it exactly, do not reformat it.' },
      name: { type: 'string' },
      phone: { type: 'string', description: 'Phone number in E.164 format if possible.' },
      email: { type: 'string', description: 'Required - the booking system needs a real email to send the confirmation to. Ask for it if not already given.' },
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
    'Save lead/qualification details as soon as you learn them, even if the patient has not booked yet — this ensures follow-up happens. Call again to update as you learn more.',
  speak_during_execution: false,
  timeout_ms: 3000,
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      phone: { type: 'string' },
      email: { type: 'string' },
      treatment_interest: { type: 'string' },
      budget: { type: 'string', description: 'Loose budget signal if volunteered, e.g. "under $500". Never pressure for this.' },
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
    "Look up an appointment the caller EXPLICITLY says they already made (e.g. \"find my appointment\", \"do I have a booking\"). Do NOT call this just because you collected a phone number - collecting phone is also a normal step of booking a brand-new appointment, which needs check_availability + book_appointment instead, not this.",
  speak_during_execution: true,
  execution_message_description: 'Let me pull that up.',
  timeout_ms: 5000,
  parameters: {
    type: 'object',
    properties: {
      phone: { type: 'string', description: 'Phone number the original booking was made under.' },
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
  execution_message_description: "I'm cancelling that now.",
  // Above scheduling.js's cancelBooking axios timeout (6000ms) - was 5000 here, which was
  // actually *below* the axios timeout it wraps, guaranteeing a Retell-side timeout first.
  timeout_ms: 9000,
  parameters: {
    type: 'object',
    properties: {
      phone: { type: 'string', description: 'Phone number the original booking was made under.' },
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
    "Move the caller's existing appointment to a new time. Use check_availability first to find a new slot, confirm it out loud, then call this.",
  speak_during_execution: true,
  execution_message_description: "I'm moving that for you.",
  // This tool runs cancel then book SEQUENTIALLY server-side (see reschedule-appointment in
  // src/routes/functions.js) - worst case is both axios timeouts back to back (~12s), so this
  // needs real headroom above that, not just above a single call.
  timeout_ms: 15000,
  parameters: {
    type: 'object',
    properties: {
      phone: { type: 'string', description: 'Phone number the original booking was made under.' },
      new_start_time: { type: 'string', description: 'The exact "start" ISO value from check_availability for the slot the patient agreed to - copy it exactly, do not reformat it.' },
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
    "Fix/correct the name, email, or phone number on an appointment that was just booked or already exists - e.g. the caller misspoke their email and wants it corrected. Do NOT call book_appointment again for this (it will fail - the slot is already taken by their own booking). The appointment time does not change.",
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
