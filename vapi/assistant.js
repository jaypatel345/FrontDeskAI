import { config } from '../src/config.js';
import { receptionistPrompt, firstMessage } from '../agent/receptionistPrompt.js';
import {
  searchKnowledgeBaseTool,
  checkAvailabilityTool,
  bookAppointmentTool,
  captureLeadTool,
  lookupAppointmentTool,
  cancelAppointmentTool,
  rescheduleAppointmentTool,
  updateAppointmentDetailsTool,
} from '../retell/tools.js';

// Vapi posts every tool call and call event to this one URL (see src/routes/vapiWebhook.js).
const serverUrl = `${config.baseUrl}/webhooks/vapi`;
const headers = config.functionsSecret ? { 'x-functions-secret': config.functionsSecret } : {};

// Tool names, descriptions and argument schemas are the ones in retell/tools.js, so both
// platforms give the model identical instructions; only the wrapper differs.
function toVapiTool(retellTool) {
  return {
    type: 'function',
    function: {
      name: retellTool.name,
      description: retellTool.description,
      parameters: retellTool.parameters,
    },
    server: { url: serverUrl, headers, timeoutSeconds: Math.ceil(retellTool.timeout_ms / 1000) },
    // Spoken while the tool runs ("Let me check the calendar."), same as Retell's execution message.
    messages: retellTool.speak_during_execution
      ? [{ type: 'request-start', content: retellTool.execution_message_description, blocking: false }]
      : [],
  };
}

export const tools = [
  searchKnowledgeBaseTool,
  checkAvailabilityTool,
  bookAppointmentTool,
  captureLeadTool,
  lookupAppointmentTool,
  cancelAppointmentTool,
  rescheduleAppointmentTool,
  updateAppointmentDetailsTool,
].map(toVapiTool);

tools.push(
  {
    type: 'transferCall',
    destinations: [
      {
        type: 'number',
        number: config.humanTransferNumber,
        message: "I'm transferring you to a member of our front desk team now.",
        transferPlan: { mode: 'blind-transfer' },
      },
    ],
  },
  { type: 'endCall' }
);

// Retell's state machine (greeting -> FAQ / booking -> escalation) is replaced by one prompt: the
// shared instructions already spell out the flow, and these lines cover what the states added.
const vapiAddendum = `
## Transfers
- Use the transferCall tool for an upset caller, an explicit request for a person, or any
  clinical question. A browser test call can't be transferred - if the transfer fails, apologise,
  offer a callback, and if their need is about an existing appointment, handle it directly with
  lookup_appointment / reschedule_appointment / cancel_appointment.
- When the caller's request is fully handled and they have nothing else, say goodbye and use endCall.
`;

export const assistant = {
  name: config.vapi.assistantName,
  firstMessage,
  firstMessageMode: 'assistant-speaks-first',
  model: {
    provider: config.vapi.modelProvider,
    model: config.vapi.model,
    temperature: 0.4,
    messages: [
      {
        role: 'system',
        // Vapi renders LiquidJS: this becomes e.g. "Monday, October 05, 2026, 03:45 PM (-0700)".
        content:
          receptionistPrompt({
            currentTime: `{{"now" | date: "%A, %B %d, %Y, %I:%M %p (%z)", "${config.clinicTimezone}"}}`,
          }) + vapiAddendum,
      },
    ],
    tools,
  },
  voice: { provider: config.vapi.voiceProvider, voiceId: config.vapi.voiceId },
  transcriber: { provider: 'deepgram', model: 'nova-3', language: 'en' },
  server: { url: serverUrl, headers, timeoutSeconds: 20 },
  serverMessages: ['status-update', 'end-of-call-report'],
  artifactPlan: { recordingEnabled: true },
  maxDurationSeconds: 15 * 60,
};
