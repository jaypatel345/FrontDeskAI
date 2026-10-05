import { config } from '../src/config.js';
import { receptionistPrompt, firstMessage } from '../agent/receptionistPrompt.js';
import { searchKnowledgeBaseTool, checkAvailabilityTool, bookAppointmentTool, captureLeadTool } from './tools.js';

// Retell fills {{current_time_<tz>}} with the current time in the clinic's timezone.
export const generalPrompt = receptionistPrompt({ currentTime: `{{current_time_${config.clinicTimezone}}}` });

export const states = [
  {
    name: 'greeting',
    state_prompt:
      'Greet the caller as the clinic receptionist and ask what they are calling about today. Route based on their answer.',
    edges: [
      { destination_state_name: 'faq_inquiry', description: 'Caller has a question about services, pricing, hours, or the process.' },
      { destination_state_name: 'qualify_and_book', description: 'Caller wants to book a new appointment, or look up, change, or cancel an appointment they already have.' },
      { destination_state_name: 'human_escalation', description: 'Caller is upset, explicitly asks for a person, or has a request unrelated to appointments/services entirely.' },
    ],
  },
  {
    name: 'faq_inquiry',
    state_prompt:
      'Answer using search_knowledge_base, 1-2 sentences, price RANGES only, then ask if they would like to book.',
    tools: [searchKnowledgeBaseTool],
    edges: [
      { destination_state_name: 'qualify_and_book', description: 'Caller wants to book after getting their question answered.' },
      { destination_state_name: 'human_escalation', description: 'Question is clinical/complex or caller is unhappy with the answer.' },
    ],
  },
  {
    name: 'qualify_and_book',
    state_prompt:
      'New booking (or "can I schedule"/availability question): qualify (treatment + timing), capture_lead, then check_availability -> book_appointment (name, phone, email all required). Caller already has an appointment (said so explicitly): lookup_appointment / reschedule_appointment / cancel_appointment. Confirm the final result clearly before ending.',
    tools: [captureLeadTool, checkAvailabilityTool, bookAppointmentTool],
    edges: [
      { destination_state_name: 'human_escalation', description: 'Caller becomes upset or the booking cannot be completed after two attempts.' },
    ],
  },
  {
    name: 'human_escalation',
    state_prompt:
      'Apologize briefly, say you are transferring to a team member, then use the transfer tool. If it fails (e.g. a web call) and their need is actually about an existing appointment, use lookup_appointment/reschedule_appointment/cancel_appointment directly instead of leaving them stuck.',
    edges: [
      { destination_state_name: 'qualify_and_book', description: 'Caller wants to make a brand new booking instead of continuing to wait for a transfer.' },
    ],
  },
];

export const startingState = 'greeting';
export const beginMessage = firstMessage;
