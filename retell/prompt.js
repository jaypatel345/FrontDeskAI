import { config } from '../src/config.js';
import { receptionistPrompt, firstMessage } from '../agent/receptionistPrompt.js';
import { searchKnowledgeBaseTool, checkAvailabilityTool, bookAppointmentTool, captureLeadTool, generalTools } from './tools.js';
import { getIndustry } from '../src/industries/registry.js';

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
      'Answer using search_knowledge_base in 1-2 spoken sentences. Give price RANGES only, mention exact pricing is given at consultation, then proactively invite them to check open consultation times.',
    tools: [searchKnowledgeBaseTool],
    edges: [
      { destination_state_name: 'qualify_and_book', description: 'Caller wants to book after getting their question answered.' },
      { destination_state_name: 'human_escalation', description: 'Question is clinical/complex or caller is unhappy with the answer.' },
    ],
  },
  {
    name: 'qualify_and_book',
    state_prompt:
      'New booking or availability: capture_lead, check_availability, offer AT MOST TWO concrete slot options (2-option rule). Once a slot is agreed on, collect name, phone (read back to confirm), and email. Then call book_appointment and give a warm 3-part confirmation. If caller already has an appointment: lookup_appointment / reschedule_appointment / cancel_appointment.',
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

export function getRetellPayload(industryKey = 'clinic') {
  const industry = getIndustry(industryKey);
  const tz = industry.timezone || config.clinicTimezone;
  const prompt = industry.getPrompt(`{{current_time_${tz}}}`);
  const firstMsg = industry.getFirstMessage();

  return {
    industryId: industry.id,
    agentName: industry.id === 'clinic' ? config.retell.agentName : `${industry.businessName} Receptionist`,
    llmPayload: {
      model: config.retell.llmModel,
      general_prompt: prompt,
      general_tools: generalTools,
      states: [
        {
          name: 'greeting',
          state_prompt: `Greet the caller as the front desk representative for ${industry.businessName} and ask what they are calling about today. Route based on their answer.`,
          edges: [
            { destination_state_name: 'faq_inquiry', description: 'Caller has a question about offerings, listings, services, hours, or pricing.' },
            { destination_state_name: 'qualify_and_book', description: 'Caller wants to schedule a tour, consultation, demo, or meeting, or modify a booking.' },
            { destination_state_name: 'human_escalation', description: 'Caller is upset, explicitly asks for a person, or has an urgent escalation.' },
          ],
        },
        {
          name: 'faq_inquiry',
          state_prompt: 'Answer using search_knowledge_base in 1-2 spoken sentences. Then proactively invite them to check open times on the calendar.',
          tools: [searchKnowledgeBaseTool],
          edges: [
            { destination_state_name: 'qualify_and_book', description: 'Caller wants to schedule after getting their question answered.' },
            { destination_state_name: 'human_escalation', description: 'Question cannot be answered or caller is frustrated.' },
          ],
        },
        {
          name: 'qualify_and_book',
          state_prompt: 'Capture lead, check availability, offer AT MOST TWO concrete slot options (2-option rule). Collect name, phone (read back), and email. Book appointment and give warm confirmation.',
          tools: [captureLeadTool, checkAvailabilityTool, bookAppointmentTool],
          edges: [
            { destination_state_name: 'human_escalation', description: 'Caller becomes upset or booking cannot be completed.' },
          ],
        },
        {
          name: 'human_escalation',
          state_prompt: 'Apologize warmly, offer a callback, and transfer if phone transfer is supported.',
          edges: [],
        },
      ],
      starting_state: 'greeting',
      start_speaker: 'agent',
      begin_message: firstMsg,
    },
  };
}

