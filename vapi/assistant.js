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

// The voice callers hear everywhere (phone line, Vapi dashboard tests, website demos): the same
// settings the Upper Layer Studio demo page uses - Cartesia's default model for this voice, no
// filler words injected.
export const voice = {
  provider: config.vapi.voiceProvider,
  voiceId: config.vapi.voiceId,
  ...(config.vapi.voiceProvider === 'cartesia'
    ? { fillerInjectionEnabled: false }
    : config.vapi.voiceProvider === '11labs'
    ? { model: 'eleven_flash_v2_5', stability: 0.45, similarityBoost: 0.75, style: 0.2, speed: 0.98 }
    : {}),
};

// Turn-taking. A fixed 0.35s silence rule was fast but cut callers off mid-dictation ("my email is
// jay patel ... 2 1 0 7 7 6 at gmail") and the agent answered half an email. Smart endpointing
// reads whether the sentence sounds finished: quick after a complete answer, patient while someone
// is still reading out an email or phone number. The transcription rule is the fallback.
export const startSpeakingPlan = {
  waitSeconds: 0.3,
  smartEndpointingPlan: { provider: 'vapi' },
  transcriptionEndpointingPlan: { onPunctuationSeconds: 0.2, onNoPunctuationSeconds: 1.0, onNumberSeconds: 0.8 },
};

// One word ("okay") was enough to cut the agent off mid-sentence; two words and 0.3s of speech
// lets a caller still interrupt without every acknowledgement doing it.
export const stopSpeakingPlan = {
  numWords: 2,
  voiceSeconds: 0.3,
  backoffSeconds: 1,
};

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
    voice,
    transcriber: { provider: 'deepgram', model: 'nova-3', language: 'en' },
    startSpeakingPlan,
    stopSpeakingPlan,
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
  voice,
  transcriber: { provider: 'deepgram', model: 'nova-3', language: 'en' },
  startSpeakingPlan,
  stopSpeakingPlan,
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
Facts from the clinic's own website: {{ clinic_facts | default: "none loaded - use search_knowledge_base" }}
Lead doctor: {{ doctor | default: "our doctor" }}. Prices are in {{ currency | default: "USD" }}; if a price isn't in these facts or search_knowledge_base, say it's confirmed at the consultation.
Reply in {{ language | default: "English" }} unless the caller speaks another language, then match theirs.
`;

export function getVapiDemoAssistant() {
  const serverUrl = `${config.baseUrl}/webhooks/vapi/demo`;
  return {
    name: 'FrontDesk Demo Receptionist',
    firstMessage: 'Hello! Thanks for calling {{ clinic_name | default: "Demo Smile Clinic" }}. This is Ava, how can I help you today?',
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
              // Defaults keep it sensible when started without variables (e.g. a Vapi dashboard test).
              clinicName: '{{ clinic_name | default: "Demo Smile Clinic" }}',
              clinicLocation: '{{ city | default: "town" }}',
              kind: '{{ niche | default: "clinic" }}',
              currentTime: '{{"now" | date: "%A, %B %d, %Y, %I:%M %p", timezone | default: "UTC"}}',
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
