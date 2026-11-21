import { config } from '../src/config.js';
import { receptionistPrompt, firstMessage, clinicPrompt } from '../agent/receptionistPrompt.js';
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
## Transfers
- Only use transferCall on a domestic line that supports it. Otherwise (or if it fails) offer a callback or to book them now.
- When the caller has nothing else, say a warm goodbye and use endCall.
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
      temperature: 0.4,
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
      waitSeconds: 0.1,
      transcriptionEndpointingPlan: { onPunctuationSeconds: 0.18, onNoPunctuationSeconds: 0.35, onNumberSeconds: 0.4 },
    },
    stopSpeakingPlan: {
      numWords: 1,
      voiceSeconds: 0.2,
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
    temperature: 0.4,
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
    waitSeconds: 0.1,
    transcriptionEndpointingPlan: { onPunctuationSeconds: 0.18, onNoPunctuationSeconds: 0.35, onNumberSeconds: 0.4 },
  },
  stopSpeakingPlan: {
    numWords: 1,
    voiceSeconds: 0.2,
    backoffSeconds: 1,
  },
  server: { url: defaultServerUrl, headers, timeoutSeconds: 20 },
  serverMessages: ['status-update', 'end-of-call-report'],
  artifactPlan: { recordingEnabled: true },
  maxDurationSeconds: 15 * 60,
};


// ---------- Personalised website demo assistant ----------
// One assistant for every prospect: the Upper Layer Studio demo page starts it with
// variableValues from FrontDesk's /demo/profiles API (clinic name, services, prices, hours...).
// Its server URL is /webhooks/vapi/demo, so its tools always run in demo mode: that clinic's own
// knowledge base, fake calendar slots, nothing sent to Cal.com, HubSpot or SMS.
const demoFacts = `
Facts from {{clinic_name}}'s own website: {{clinic_facts}}
Lead doctor: {{doctor}}. Prices are in {{currency}}; if a price isn't in these facts or search_knowledge_base, say it's confirmed at the consultation.
Reply in {{language}} unless the caller speaks another language, then match theirs.
`;

export function getVapiDemoAssistant() {
  const serverUrl = `${config.baseUrl}/webhooks/vapi/demo`;
  return {
    name: 'FrontDesk Demo Receptionist',
    firstMessage: 'Hello! Thanks for calling {{clinic_name}}. This is Ava, how can I help you today?',
    firstMessageMode: 'assistant-speaks-first',
    model: {
      provider: config.vapi.modelProvider,
      model: config.vapi.model,
      temperature: 0.4,
      messages: [
        {
          role: 'system',
          content:
            clinicPrompt({
              persona: 'Ava',
              clinicName: '{{clinic_name}}',
              clinicLocation: '{{city}}',
              kind: '{{niche}}',
              currentTime: '{{"now" | date: "%A, %B %d, %Y, %I:%M %p", timezone}}',
              isDemo: true,
              extraFacts: demoFacts,
            }) + '\nWhen the caller has nothing else, say a warm goodbye and use endCall.\n',
        },
      ],
      tools: buildTools(serverUrl).filter((t) => t.type !== 'transferCall'),
    },
    voice: assistant.voice,
    transcriber: assistant.transcriber,
    startSpeakingPlan: assistant.startSpeakingPlan,
    stopSpeakingPlan: assistant.stopSpeakingPlan,
    server: { url: serverUrl, headers, timeoutSeconds: 20 },
    serverMessages: ['status-update', 'end-of-call-report'],
    artifactPlan: { recordingEnabled: true },
    maxDurationSeconds: 10 * 60,
  };
}
