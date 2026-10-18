import { config } from '../config.js';
import { clinicPreset } from './clinic/index.js';
import { realEstatePreset } from './real-estate/index.js';
import { generalBusinessPreset } from './general-business/index.js';

export const INDUSTRIES = {
  clinic: clinicPreset,
  'real-estate': realEstatePreset,
  'general-business': generalBusinessPreset,
};

const ALIASES = {
  clinic: 'clinic',
  medical: 'clinic',
  medspa: 'clinic',
  aesthetics: 'clinic',

  'real-estate': 'real-estate',
  realestate: 'real-estate',
  realty: 'real-estate',
  realtor: 'real-estate',

  'general-business': 'general-business',
  general: 'general-business',
  corporate: 'general-business',
  business: 'general-business',
};

export function normalizeIndustryKey(key) {
  if (!key) return null;
  const clean = String(key).trim().toLowerCase();
  return ALIASES[clean] || (INDUSTRIES[clean] ? clean : null);
}

/**
 * Resolves the active industry preset from an industry key or incoming call context:
 * - Direct string key ('clinic', 'real-estate', 'general-business')
 * - Incoming phone number (matched against config.industryPhoneMap or preset phoneNumber)
 * - Assistant ID / Agent ID
 * - Express request context (query, params, body, headers)
 */
export function getIndustry(keyOrContext) {
  if (!keyOrContext) {
    const defaultKey = normalizeIndustryKey(config.defaultIndustry) || 'clinic';
    return INDUSTRIES[defaultKey];
  }

  // 1. Direct string key
  if (typeof keyOrContext === 'string') {
    const normalized = normalizeIndustryKey(keyOrContext);
    return INDUSTRIES[normalized] || INDUSTRIES[config.defaultIndustry] || INDUSTRIES.clinic;
  }

  // 2. Context object
  const ctx = keyOrContext;

  // Check explicit industry field in context/query/params/headers
  const explicit =
    ctx.industry ||
    ctx.params?.industry ||
    ctx.query?.industry ||
    ctx.headers?.['x-industry'] ||
    ctx.body?.industry ||
    ctx.body?.call?.industry;
  const explicitNormalized = normalizeIndustryKey(explicit);
  if (explicitNormalized && INDUSTRIES[explicitNormalized]) {
    return INDUSTRIES[explicitNormalized];
  }

  // Check phone number mapping
  const toNumber =
    ctx.to_number ||
    ctx.toNumber ||
    ctx.to ||
    ctx.phoneNumber?.number ||
    ctx.call?.phoneNumber?.number ||
    ctx.body?.call?.to_number;
  if (toNumber) {
    const mapped = config.industryPhoneMap?.[toNumber];
    const mappedNormalized = normalizeIndustryKey(mapped);
    if (mappedNormalized && INDUSTRIES[mappedNormalized]) {
      return INDUSTRIES[mappedNormalized];
    }
    for (const [key, preset] of Object.entries(INDUSTRIES)) {
      const cfg = config.industries?.[key];
      if (cfg?.phoneNumber && cfg.phoneNumber === toNumber) {
        return preset;
      }
    }
  }

  // Check assistant ID / agent ID
  const assistantId =
    ctx.assistant_id ||
    ctx.assistantId ||
    ctx.call?.assistantId ||
    ctx.body?.message?.call?.assistantId;
  const agentId =
    ctx.agent_id ||
    ctx.agentId ||
    ctx.call?.agent_id ||
    ctx.body?.call?.agent_id;

  if (assistantId) {
    for (const [key, preset] of Object.entries(INDUSTRIES)) {
      if (config.industries?.[key]?.vapiAssistantId === assistantId) {
        return preset;
      }
    }
  }

  if (agentId) {
    for (const [key, preset] of Object.entries(INDUSTRIES)) {
      if (config.industries?.[key]?.retellAgentId === agentId) {
        return preset;
      }
    }
  }

  // Fallback to default
  const defaultKey = normalizeIndustryKey(config.defaultIndustry) || 'clinic';
  return INDUSTRIES[defaultKey] || INDUSTRIES.clinic;
}

export function listIndustries() {
  return Object.values(INDUSTRIES);
}

export function listIndustryIds() {
  return Object.keys(INDUSTRIES);
}
