import fs from 'node:fs';
import { config } from '../../config.js';
import { SERVICES, canonicalService } from './services.js';
import { createPrompt, createFirstMessage } from './prompt.js';

const kbPath = new URL('./knowledgeBase.json', import.meta.url);
const knowledgeBase = JSON.parse(fs.readFileSync(kbPath, 'utf-8'));

export const clinicPreset = {
  id: 'clinic',
  name: 'Clinic / Medical Spa',
  businessName: config.industries.clinic.name,
  location: config.industries.clinic.location,
  timezone: config.industries.clinic.timezone,
  personaName: config.industries.clinic.personaName,
  services: SERVICES,
  canonicalService,
  knowledgeBase,
  createPrompt,
  createFirstMessage,
  // Helper to get formatted default prompt
  getPrompt: (currentTime) => createPrompt({ currentTime }),
  getFirstMessage: () => createFirstMessage(),
};

export default clinicPreset;
