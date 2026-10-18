import fs from 'node:fs';
import { config } from '../../config.js';
import { SERVICES, canonicalService } from './services.js';
import { createPrompt, createFirstMessage } from './prompt.js';

const kbPath = new URL('./knowledgeBase.json', import.meta.url);
const knowledgeBase = JSON.parse(fs.readFileSync(kbPath, 'utf-8'));

export const generalBusinessPreset = {
  id: 'general-business',
  name: 'General Business / Corporate Front Desk',
  businessName: config.industries['general-business']?.name || 'Vanguard Enterprise Solutions',
  location: config.industries['general-business']?.location || 'Corporate Headquarters',
  timezone: config.industries['general-business']?.timezone || 'America/Los_Angeles',
  personaName: config.industries['general-business']?.personaName || 'Jordan',
  services: SERVICES,
  canonicalService,
  knowledgeBase,
  createPrompt,
  createFirstMessage,
  getPrompt: (currentTime) => createPrompt({ currentTime }),
  getFirstMessage: () => createFirstMessage(),
};

export default generalBusinessPreset;
