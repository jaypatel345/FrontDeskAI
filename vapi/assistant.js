import { config } from '../src/config.js';
import { receptionistPrompt, firstMessage } from '../agent/receptionistPrompt.js';
import { getIndustry } from '../src/industries/registry.js';
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
const defaultServerUrl = `${config.baseUrl}/webhooks/vapi`;
const headers = config.functionsSecret ? { 'x-functions-secret': config.functionsSecret } : {};

// Tool names, descriptions and argument schemas are the ones in retell/tools.js, so both
// platforms give the model identical instructions; only the wrapper differs.
function toVapiTool(retellTool, serverUrl = defaultServerUrl) {
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

export function buildTools(serverUrl = defaultServerUrl) {
  const list = [
    searchKnowledgeBaseTool,
    checkAvailabilityTool,
    bookAppointmentTool,
    captureLeadTool,
    lookupAppointmentTool,
    cancelAppointmentTool,
    rescheduleAppointmentTool,
    updateAppointmentDetailsTool,
  ].map((t) => toVapiTool(t, serverUrl));

  list.push(
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

  return list;
}

export const tools = buildTools(defaultServerUrl);

const vapiAddendum = `
## Transfers & Escalations
- For an upset caller, an explicit request for a person, or complex questions:
  Since this demo telephony line cannot dial international numbers (+91) directly, do NOT crash the call with transferCall if the transfer number is international or fails. Instead, warmly say: "Our front desk team is currently assisting other guests. I can take down your name and number for an immediate callback, or I would be happy to help get you scheduled on our calendar right now — which would you prefer?"
- Only invoke transferCall if you are on a compatible domestic line where live transfers are supported.
- When the caller's request is fully handled and they have nothing else, say a warm goodbye and use endCall.
`;

export function getVapiAssistant(industryKey = 'clinic') {
  const industry = getIndustry(industryKey);
  const serverUrl = `${config.baseUrl}/webhooks/vapi/${industry.id}`;
  const tz = industry.timezone || config.clinicTimezone;
  const assistantTools = buildTools(serverUrl);

  const assistantName =
    industry.id === 'clinic'
      ? config.vapi.assistantName
      : `${industry.businessName} Assistant`;

  return {
    name: assistantName,
    firstMessage: industry.getFirstMessage(),
    firstMessageMode: 'assistant-speaks-first',
    model: {
      provider: config.vapi.modelProvider,
      model: config.vapi.model,
      temperature: 0.7,
      messages: [
        {
          role: 'system',
          content:
            industry.getPrompt(`{{"now" | date: "%A, %B %d, %Y, %I:%M %p (%z)", "${tz}"}}`) +
            vapiAddendum,
        },
      ],
      tools: assistantTools,
    },
    voice: {
      provider: config.vapi.voiceProvider,
      voiceId: config.vapi.voiceId,
      ...(config.vapi.voiceProvider === 'cartesia'
        ? { model: 'sonic-3.5' }
        : config.vapi.voiceProvider === '11labs'
        ? { model: 'eleven_flash_v2_5', stability: 0.45, similarityBoost: 0.75, style: 0.2, speed: 0.98 }
        : {}),
    },
    transcriber: { provider: 'deepgram', model: 'nova-3', language: 'en' },
    startSpeakingPlan: {
      waitSeconds: 0.3,
      transcriptionEndpointingPlan: { onPunctuationSeconds: 0.25, onNoPunctuationSeconds: 1.0, onNumberSeconds: 0.7 },
    },
    stopSpeakingPlan: {
      numWords: 2,
      voiceSeconds: 0.3,
      backoffSeconds: 1,
    },
    server: { url: serverUrl, headers, timeoutSeconds: 20 },
    serverMessages: ['status-update', 'end-of-call-report'],
    artifactPlan: { recordingEnabled: true },
    maxDurationSeconds: 15 * 60,
  };
}

// Default export for backward compatibility with existing tests
export const assistant = {
  name: config.vapi.assistantName,
  firstMessage,
  firstMessageMode: 'assistant-speaks-first',
  model: {
    provider: config.vapi.modelProvider,
    model: config.vapi.model,
    temperature: 0.7,
    messages: [
      {
        role: 'system',
        content:
          receptionistPrompt({
            currentTime: `{{"now" | date: "%A, %B %d, %Y, %I:%M %p (%z)", "${config.clinicTimezone}"}}`,
          }) + vapiAddendum,
      },
    ],
    tools,
  },
  voice: {
    provider: config.vapi.voiceProvider,
    voiceId: config.vapi.voiceId,
    ...(config.vapi.voiceProvider === 'cartesia'
      ? { model: 'sonic-3.5' }
      : config.vapi.voiceProvider === '11labs'
      ? { model: 'eleven_flash_v2_5', stability: 0.45, similarityBoost: 0.75, style: 0.2, speed: 0.98 }
      : {}),
  },
  transcriber: { provider: 'deepgram', model: 'nova-3', language: 'en' },
  startSpeakingPlan: {
    waitSeconds: 0.3,
    transcriptionEndpointingPlan: { onPunctuationSeconds: 0.25, onNoPunctuationSeconds: 1.0, onNumberSeconds: 0.7 },
  },
  stopSpeakingPlan: {
    numWords: 2,
    voiceSeconds: 0.3,
    backoffSeconds: 1,
  },
  server: { url: defaultServerUrl, headers, timeoutSeconds: 20 },
  serverMessages: ['status-update', 'end-of-call-report'],
  artifactPlan: { recordingEnabled: true },
  maxDurationSeconds: 15 * 60,
};

