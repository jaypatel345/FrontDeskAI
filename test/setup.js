// Imported first by every test file, before anything from src/, so config.js sees these values.
// dotenv never overrides a variable that's already set (even to ""), so blanking the live keys
// here keeps every integration in mock mode even when the local .env has real credentials -
// tests must never book, text or create contacts for real.
const env = {
  NODE_ENV: 'production', // exercise the fail-closed auth paths
  FUNCTIONS_SECRET: 'test-functions-secret',
  DASHBOARD_USER: 'admin',
  DASHBOARD_PASSWORD: 'test-dashboard-password',
  RETELL_API_KEY: 'test-retell-key',
  DB_PATH: ':memory:',
  CALCOM_API_KEY: '',
  CALCOM_EVENT_TYPE_ID: '',
  HUBSPOT_API_KEY: '',
  TWILIO_ACCOUNT_SID: '',
  TWILIO_AUTH_TOKEN: '',
  TWILIO_FROM_NUMBER: '',
  OPENAI_API_KEY: '',
  BLAND_API_KEY: '',
};
Object.assign(process.env, env);

// Mock-mode CRM/SMS log every call; keep test output readable.
console.log = () => {};
