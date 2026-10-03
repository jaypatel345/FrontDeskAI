import 'dotenv/config';

export const config = {
  port: process.env.PORT || 3000,
  baseUrl: process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`,

  retell: {
    apiKey: process.env.RETELL_API_KEY,
    voiceId: process.env.RETELL_VOICE_ID,
    llmModel: process.env.RETELL_LLM_MODEL || 'claude-4.5-haiku',
    agentName: process.env.RETELL_AGENT_NAME || 'Clinic Receptionist',
  },

  bland: {
    apiKey: process.env.BLAND_API_KEY || null,
    voiceId: process.env.BLAND_VOICE_ID || null,
    phoneNumber: process.env.BLAND_PHONE_NUMBER || null,
  },

  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',

  qdrant: {
    url: process.env.QDRANT_URL || 'http://localhost:6333',
    apiKey: process.env.QDRANT_API_KEY || null,
    collection: process.env.QDRANT_COLLECTION || 'clinic_kb',
  },

  openaiApiKey: process.env.OPENAI_API_KEY || null,

  calcom: {
    apiKey: process.env.CALCOM_API_KEY || null,
    eventTypeId: process.env.CALCOM_EVENT_TYPE_ID || null,
  },

  hubspotApiKey: process.env.HUBSPOT_API_KEY || null,

  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID || null,
    authToken: process.env.TWILIO_AUTH_TOKEN || null,
    fromNumber: process.env.TWILIO_FROM_NUMBER || null,
  },

  humanTransferNumber: process.env.HUMAN_TRANSFER_NUMBER || '+15555550100',
  clinicTimezone: process.env.CLINIC_TIMEZONE || 'America/Los_Angeles',
  dbPath: process.env.DB_PATH || './data/clinic.db',
};
