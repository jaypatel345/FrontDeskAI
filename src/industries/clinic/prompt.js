import { config } from '../../config.js';
import { clinicPrompt, clinicIsDemo } from '../../../agent/receptionistPrompt.js';

export function createPrompt({ currentTime, name, location, personaName } = {}) {
  const clinicName = name || config.industries.clinic.name || config.clinicName;
  return clinicPrompt({
    persona: personaName || config.industries.clinic.personaName || 'Ava',
    clinicName,
    clinicLocation: location || config.industries.clinic.location || config.clinicLocation,
    currentTime: currentTime || 'right now',
    isDemo: clinicIsDemo(clinicName),
  });
}

export function createFirstMessage({ name, personaName } = {}) {
  const clinicName = name || config.industries.clinic.name || config.clinicName;
  const persona = personaName || config.industries.clinic.personaName || 'Ava';
  return `Hello! Thanks for calling ${clinicName}. This is ${persona} — how can I help you today?`;
}
