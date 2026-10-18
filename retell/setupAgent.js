import fs from 'node:fs';
import axios from 'axios';
import { config } from '../src/config.js';
import { generalPrompt, states, startingState, beginMessage, getRetellPayload } from './prompt.js';
import { generalTools } from './tools.js';
import { listIndustryIds, normalizeIndustryKey } from '../src/industries/registry.js';

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

function getStateFile(industryKey) {
  return industryKey === 'clinic'
    ? new URL('./.deployed-agent.json', import.meta.url)
    : new URL(`./.deployed-agent-${industryKey}.json`, import.meta.url);
}

function buildAgentPayload(agentName, industryKey) {
  return {
    agent_name: agentName,
    voice_id: config.retell.voiceId,
    voice_speed: 0.95,
    voice_temperature: 1.15,
    enable_backchannel: true,
    backchannel_frequency: 0.8,
    backchannel_words: ['mm-hmm', 'I see', 'got it'],
    ambient_sound: 'call-center',
    ambient_sound_volume: 0.3,
    language: 'en-US',
    webhook_url: `${config.baseUrl}/webhooks/retell/${industryKey}`,
    webhook_events: ['call_started', 'call_ended', 'call_analyzed'],
    interruption_sensitivity: 1,
    max_call_duration_ms: 15 * 60 * 1000,
  };
}

async function setupSingleAgent(industryKey) {
  const stateFile = getStateFile(industryKey);
  const existing = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf-8')) : null;

  let llmPayload;
  let agentName;
  if (industryKey === 'clinic') {
    llmPayload = {
      model: config.retell.llmModel,
      general_prompt: generalPrompt,
      general_tools: generalTools,
      states,
      starting_state: startingState,
      start_speaker: 'agent',
      begin_message: beginMessage,
    };
    agentName = config.retell.agentName;
  } else {
    const payloadInfo = getRetellPayload(industryKey);
    llmPayload = payloadInfo.llmPayload;
    agentName = payloadInfo.agentName;
  }

  const agentPayload = buildAgentPayload(agentName, industryKey);

  console.log(`\n--- Setting up Retell Agent for [${industryKey}]: "${agentName}" ---`);

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

  fs.writeFileSync(stateFile, JSON.stringify({ llm_id: llmId, agent_id: agentId, industry: industryKey }, null, 2));
  console.log(`Done. Agent ID: ${agentId}`);
  return agentId;
}

async function main() {
  const rawArg = process.argv[2] ? process.argv[2].replace(/^--industry=/, '').trim().toLowerCase() : null;

  if (rawArg === 'all') {
    for (const key of listIndustryIds()) {
      await setupSingleAgent(key);
    }
  } else if (rawArg) {
    const norm = normalizeIndustryKey(rawArg);
    if (!norm) {
      console.error(`Unknown industry "${rawArg}". Available: ${listIndustryIds().join(', ')}, all`);
      process.exit(1);
    }
    await setupSingleAgent(norm);
  } else {
    // Default to clinic
    await setupSingleAgent('clinic');
  }

  console.log('\nAll done.');
}

main().catch((err) => {
  console.error('Setup failed:', err.response?.data || err.message);
  process.exit(1);
});

