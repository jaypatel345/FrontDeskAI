import fs from 'node:fs';
import { config } from '../../config.js';
import { SERVICES, canonicalService } from './services.js';
import { createPrompt, createFirstMessage } from './prompt.js';

const kbPath = new URL('./knowledgeBase.json', import.meta.url);
const knowledgeBase = JSON.parse(fs.readFileSync(kbPath, 'utf-8'));

export const realEstatePreset = {
  id: 'real-estate',
  name: 'Real Estate Agency',
  businessName: config.industries['real-estate']?.name || 'Apex Realty Group',
  location: config.industries['real-estate']?.location || 'Greater Metro Area',
  timezone: config.industries['real-estate']?.timezone || 'America/Los_Angeles',
  personaName: config.industries['real-estate']?.personaName || 'Marcus',
  services: SERVICES,
  canonicalService,
  knowledgeBase,
  createPrompt,
  createFirstMessage,
  getPrompt: (currentTime) => createPrompt({ currentTime }),
  getFirstMessage: () => createFirstMessage(),
};

export default realEstatePreset;
