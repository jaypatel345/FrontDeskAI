import fs from 'node:fs';
import axios from 'axios';
import { config } from '../src/config.js';
import { generalPrompt, states, startingState, beginMessage } from './prompt.js';
import { generalTools } from './tools.js';

const STATE_FILE = new URL('./.deployed-agent.json', import.meta.url);

if (!config.retell.apiKey) {
  console.error('RETELL_API_KEY is not set in .env — get it from the Retell dashboard first.');
  process.exit(1);
}
if (!config.retell.voiceId) {
  console.error('RETELL_VOICE_ID is not set in .env — pick a voice in the Retell dashboard > Voices and copy its id.');
  process.exit(1);
}
if (config.baseUrl.includes('localhost')) {
  console.warn('WARNING: BASE_URL is still localhost — Retell cannot reach your machine. Point it at your ngrok/deployed URL before running this.');
}

const http = axios.create({
  baseURL: 'https://api.retellai.com',
  headers: { Authorization: `Bearer ${config.retell.apiKey}`, 'Content-Type': 'application/json' },
});

const llmPayload = {
  model: config.retell.llmModel,
  general_prompt: generalPrompt,
  general_tools: generalTools,
  states,
  starting_state: startingState,
  start_speaker: 'agent',
  begin_message: beginMessage,
};

const agentPayload = {
  agent_name: config.retell.agentName,
  voice_id: config.retell.voiceId,
  voice_speed: 0.95,
  voice_temperature: 1.15,
  // Backchanneling ("mm-hmm", "I see") while the caller is talking, a touch of pitch/pacing
  // variation (voice_temperature above the 1.0 default), and a faint office ambience are what
  // separate a natural-sounding agent from a flat TTS read - none of this is prompt-controllable,
  // it's all agent-level config Retell exposes for exactly this ask.
  enable_backchannel: true,
  backchannel_frequency: 0.8,
  backchannel_words: ['mm-hmm', 'I see', 'got it'],
  ambient_sound: 'call-center',
  ambient_sound_volume: 0.3,
  language: 'en-US',
  webhook_url: `${config.baseUrl}/webhooks/retell`,
  webhook_events: ['call_started', 'call_ended', 'call_analyzed'],
  interruption_sensitivity: 1,
  max_call_duration_ms: 15 * 60 * 1000,
};

async function main() {
  const existing = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) : null;

  let llmId;
  if (existing?.llm_id) {
    await http.patch(`/update-retell-llm/${existing.llm_id}`, llmPayload);
    llmId = existing.llm_id;
    console.log(`Updated existing LLM ${llmId}`);
  } else {
    const res = await http.post('/create-retell-llm', llmPayload);
    llmId = res.data.llm_id;
    console.log(`Created LLM ${llmId}`);
  }

  let agentId;
  const fullAgentPayload = { ...agentPayload, response_engine: { type: 'retell-llm', llm_id: llmId } };
  if (existing?.agent_id) {
    await http.patch(`/update-agent/${existing.agent_id}`, fullAgentPayload);
    agentId = existing.agent_id;
    console.log(`Updated existing agent ${agentId}`);
  } else {
    const res = await http.post('/create-agent', fullAgentPayload);
    agentId = res.data.agent_id;
    console.log(`Created agent ${agentId}`);
  }

  fs.writeFileSync(STATE_FILE, JSON.stringify({ llm_id: llmId, agent_id: agentId }, null, 2));
  console.log('\nDone. In the Retell dashboard:');
  console.log(`  - Open Agent ${agentId} and use "Test Call" (web call) to try it with zero phone setup.`);
  console.log('  - Attach a phone number to this agent under Phone Numbers when ready for real calls.');
}

main().catch((err) => {
  console.error('Setup failed:', err.response?.data || err.message);
  console.error('\nIf field names have drifted from what this script expects, check the current');
  console.error('schema at https://docs.retellai.com/api-references/create-retell-llm and');
  console.error('https://docs.retellai.com/api-references/create-agent, or configure the agent');
  console.error('directly in the dashboard using retell/prompt.js and retell/tools.js as the source of truth.');
  process.exit(1);
});
